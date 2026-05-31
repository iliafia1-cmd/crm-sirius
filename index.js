/**
 * CRM Sirius — Telegram-бот для жильцов
 *
 * Возможности:
 *  - Приём заявок (адрес → телефон → тип → описание → запись в Firestore)
 *  - Кнопка "ИИ-ассистент" (пока заглушка, включим позже)
 *
 * Заявки пишутся в тот же документ Firestore crm/data, что и CRM,
 * в том же формате (поля, displayNumber ДДММ-N, статус "Новая").
 *
 * Токен бота хранится в секрете BOT_TOKEN (НЕ в коде).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const sharp = require("sharp");

admin.initializeApp();
const db = admin.firestore();

// Секрет с токеном бота — задаётся отдельной командой, в коде его нет
const BOT_TOKEN = defineSecret("BOT_TOKEN");

// ====== Типы заявок ======
// Виды работ берём ЖИВЬЁМ из CRM (crm/data → workTypes), а не зашиваем в код.
// Так список в боте всегда совпадает с CRM. Тип "обратный звонок" исключаем —
// у него отдельная кнопка в главном меню.
function isCallbackType(name) {
  return /обратн\w*\s*звон|перезвон|звонок/i.test(String(name || ""));
}

// ====== Хранение состояния диалога ======
// Для каждого чата держим, на каком шаге находится пользователь и что уже ввёл.
// Состояние храним в Firestore (коллекция bot_sessions), чтобы оно переживало
// перезапуски функции.
async function getSession(chatId) {
  const snap = await db.collection("bot_sessions").doc(String(chatId)).get();
  return snap.exists ? snap.data() : null;
}
async function setSession(chatId, data) {
  await db.collection("bot_sessions").doc(String(chatId)).set(data);
}
async function clearSession(chatId) {
  await db.collection("bot_sessions").doc(String(chatId)).delete();
}

// ====== Адреса из CRM (тот же документ crm/data) ======
// Возвращает массив объектов { id, street, house } из базы CRM.
async function getAddresses() {
  try {
    const snap = await db.collection("crm").doc("data").get();
    if (!snap.exists) return [];
    const data = snap.data() || {};
    return Array.isArray(data.addresses) ? data.addresses : [];
  } catch (e) {
    console.error("getAddresses error:", e.message);
    return [];
  }
}

// Уникальные улицы, в порядке появления
function uniqueStreets(addresses) {
  const seen = [];
  for (const a of addresses) {
    if (a && a.street && !seen.includes(a.street)) seen.push(a.street);
  }
  return seen;
}

// Клавиатура выбора улицы. В callback_data кладём ИНДЕКС улицы (street:N),
// т.к. названия кириллицей длинные, а Telegram ограничивает data 64 байтами.
function streetsKeyboard(streets) {
  const rows = streets.map((s, i) => [
    { text: s, callback_data: "street:" + i },
  ]);
  rows.push([{ text: "❌ Отмена", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

// Клавиатура выбора дома на выбранной улице.
// В callback_data кладём id адреса (house:ID) — он короткий и однозначный.
function housesKeyboard(addresses, street) {
  const rows = addresses
    .filter((a) => a.street === street)
    .map((a) => [{ text: "д. " + a.house, callback_data: "house:" + a.id }]);
  // Назад к улицам и Отмена в одной строке
  rows.push([
    { text: "⬅️ Назад к улицам", callback_data: "back_streets" },
    { text: "❌ Отмена", callback_data: "cancel" },
  ]);
  return { inline_keyboard: rows };
}

// ====== Вспомогательные функции Telegram ======
async function tgCall(method, payload) {
  const token = BOT_TOKEN.value();
  console.log(`tgCall: ${method}, token length=${token ? token.length : 'NO TOKEN'}`);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    console.log(`tgCall result: ${method}, ok=${data.ok}, ${data.ok ? 'sent' : 'ERROR: ' + JSON.stringify(data)}`);
    return data;
  } catch (e) {
    console.error(`tgCall FETCH ERROR (${method}):`, e.message);
    throw e;
  }
}

function sendMessage(chatId, text, extra) {
  return tgCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(extra || {}),
  });
}

// Главное меню (три кнопки)
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📝 Подать заявку", callback_data: "new_request" }],
      [{ text: "📞 Запросить обратный звонок", callback_data: "callback_request" }],
      [{ text: "❌ Отменить мою заявку", callback_data: "my_requests" }],
      [{ text: "🤖 ИИ-ассистент", callback_data: "ai_assistant" }],
    ],
  };
}

// Кнопки выбора типа заявки.
// Принимает массив названий типов. В callback_data кладём ИНДЕКС (type:N),
// т.к. названия кириллицей длинные, а Telegram ограничивает data 64 байтами.
function typeKeyboard(types) {
  const rows = types.map((t, i) => [{ text: t, callback_data: "type:" + i }]);
  rows.push([{ text: "❌ Отмена", callback_data: "cancel" }]);
  return { inline_keyboard: rows };
}

// Общая клавиатура для шага текста: Отправить заявку + Отмена
function submitKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Отправить заявку", callback_data: "submit" }],
      [{ text: "❌ Отмена", callback_data: "cancel" }],
    ],
  };
}

// Клавиатура для шага фото: Продолжить + Отмена.
// Колбэк тот же — submit. Обработчик уже различает действие по шагу
// (step_photo → переход к тексту, step_text → реальная отправка).
function continueKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "✅ Продолжить", callback_data: "submit" }],
      [{ text: "❌ Отмена", callback_data: "cancel" }],
    ],
  };
}

// Список видов работ из CRM (без типа "обратный звонок")
async function getRequestTypes() {
  try {
    const snap = await db.collection("crm").doc("data").get();
    const data = snap.exists ? snap.data() : {};
    const wts = Array.isArray(data.workTypes) ? data.workTypes : [];
    const names = wts.map((w) => w && w.name).filter(Boolean);
    const filtered = names.filter((n) => !isCallbackType(n));
    return filtered.length ? filtered : ["Сантехника", "Электрика", "Другое"];
  } catch (e) {
    console.error("getRequestTypes error:", e.message);
    return ["Сантехника", "Электрика", "Другое"];
  }
}

// Найти id секретаря (роль secretary, не уволен)
async function getSecretaryId() {
  try {
    const snap = await db.collection("crm").doc("data").get();
    const data = snap.exists ? snap.data() : {};
    const users = Array.isArray(data.users) ? data.users : [];
    const sec = users.find((u) => u && u.role === "secretary" && !u.fired);
    return sec ? sec.id : null;
  } catch (e) {
    console.error("getSecretaryId error:", e.message);
    return null;
  }
}

// Клавиатура запроса телефона (кнопка "Поделиться контактом" + можно ввести вручную)
function phoneKeyboard() {
  return {
    keyboard: [[{ text: "📱 Поделиться контактом", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

// Убрать клавиатуру
function removeKeyboard() {
  return { remove_keyboard: true };
}

// ====== Формат даты как в CRM: "ДД.ММ.ГГГГ ЧЧ:ММ" (московское время) ======
function nowDT() {
  const d = new Date();
  // Москва = UTC+3
  const msk = new Date(d.getTime() + 3 * 60 * 60 * 1000);
  const dd = String(msk.getUTCDate()).padStart(2, "0");
  const mm = String(msk.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = msk.getUTCFullYear();
  const hh = String(msk.getUTCHours()).padStart(2, "0");
  const mi = String(msk.getUTCMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
}

function dateKeyFromCreated(created) {
  const m = String(created).match(/^(\d{1,2})[.\/-](\d{1,2})/);
  if (!m) return "0000";
  return String(m[1]).padStart(2, "0") + String(m[2]).padStart(2, "0");
}

// Назначить displayNumber новой заявке в формате ДДММ-N
function assignDisplayNumber(req, requests) {
  const key = dateKeyFromCreated(req.created);
  let maxN = 0;
  for (const r of requests) {
    if (r === req || !r.displayNumber) continue;
    const m = String(r.displayNumber).match(/^(\d{4})-(\d+)$/);
    if (m && m[1] === key) {
      const n = parseInt(m[2], 10);
      if (n > maxN) maxN = n;
    }
  }
  req.displayNumber = key + "-" + (maxN + 1);
}

// ====== Запись заявки в Firestore (в тот же документ crm/data) ======
async function createRequest(sess, tgChatId) {
  const docRef = db.collection("crm").doc("data");
  // Транзакция: читаем документ, добавляем заявку, пишем обратно
  let displayNumber = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    const data = snap.exists ? snap.data() : {};
    if (!Array.isArray(data.requests)) data.requests = [];
    if (!data.nextId) data.nextId = {};
    if (!data.nextId.request) {
      // На всякий случай вычислим следующий id
      const maxId = data.requests.reduce((m, r) => Math.max(m, r.id || 0), 0);
      data.nextId.request = maxId + 1;
    }

    const created = nowDT();
    const req = {
      id: data.nextId.request++,
      name: sess.name || "Житель (Telegram)",
      phone: sess.phone || "",
      street: sess.street || "",
      house: sess.house || "",
      entrance: "",
      floor: "",
      apart: sess.apart || "",
      type: sess.type || "Другое",
      desc: sess.desc || "",
      assignee: sess.assignee || null,
      deadline: "",
      status: "Новая",
      created,
      createdBy: "Telegram",
      startedAt: null,
      startedBy: null,
      doneAt: null,
      closedBy: null,
      cancelledBy: null,
      photos: Array.isArray(sess.photos) ? sess.photos.slice() : [],
      tgChatId: tgChatId || null,
    };
    data.requests.unshift(req);
    assignDisplayNumber(req, data.requests);
    displayNumber = req.displayNumber;
    tx.set(docRef, data);
  });
  return displayNumber;
}

// ====== Заявки жильца: список активных, поиск, отмена ======
// Возвращает только активные (Новая / В работе) заявки этого chatId,
// отсортированные от свежих к старым.
async function getMyActiveRequests(chatId) {
  try {
    const snap = await db.collection("crm").doc("data").get();
    const data = snap.exists ? snap.data() : {};
    const reqs = Array.isArray(data.requests) ? data.requests : [];
    return reqs
      .filter(
        (r) =>
          r &&
          r.tgChatId === chatId &&
          (r.status === "Новая" || r.status === "В работе")
      )
      .sort((a, b) => (b.id || 0) - (a.id || 0));
  } catch (e) {
    console.error("getMyActiveRequests error:", e.message);
    return [];
  }
}

// Возвращает заявку по id (или null)
async function findRequestById(id) {
  try {
    const snap = await db.collection("crm").doc("data").get();
    const data = snap.exists ? snap.data() : {};
    const reqs = Array.isArray(data.requests) ? data.requests : [];
    return reqs.find((r) => r && r.id === id) || null;
  } catch (e) {
    console.error("findRequestById error:", e.message);
    return null;
  }
}

// Отменяет заявку через транзакцию. Проверяет, что заявка принадлежит этому
// жильцу (по tgChatId) и ещё активна. Возвращает обновлённую заявку или null.
async function cancelRequestByUser(id, chatId) {
  const docRef = db.collection("crm").doc("data");
  let updated = null;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) return;
      const data = snap.data();
      const reqs = Array.isArray(data.requests) ? data.requests : [];
      const idx = reqs.findIndex((r) => r && r.id === id);
      if (idx === -1) return;
      const r = reqs[idx];
      if (r.tgChatId !== chatId) return; // чужая заявка — не трогаем
      if (r.status !== "Новая" && r.status !== "В работе") return; // уже не активная
      r.status = "Отменена заявителем";
      r.cancelledBy = "Жилец (Telegram)";
      reqs[idx] = r;
      data.requests = reqs;
      tx.set(docRef, data);
      updated = r;
    });
  } catch (e) {
    console.error("cancelRequestByUser error:", e.message);
    return null;
  }
  return updated;
}


// Максимум фото на одну заявку (как в CRM)
const MAX_PHOTOS = 5;

// Скачивает файл из Telegram по file_id, возвращает data-URL "data:image/jpeg;base64,..."
// Скачивает файл из Telegram как Buffer
async function downloadTgFileAsBuffer(fileId) {
  const token = BOT_TOKEN.value();
  const infoRes = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
  );
  const info = await infoRes.json();
  if (!info.ok || !info.result || !info.result.file_path) {
    throw new Error("getFile failed: " + JSON.stringify(info));
  }
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${token}/${info.result.file_path}`
  );
  if (!fileRes.ok) throw new Error("download failed: " + fileRes.status);
  return Buffer.from(await fileRes.arrayBuffer());
}

// Сжимает картинку через sharp: до 1600px по большей стороне, JPEG с подбором
// качества, пока размер не уместится в targetBytes. Возвращает data-URL.
async function compressImageToDataUrl(inputBuffer, targetBytes = 700 * 1024) {
  let quality = 82;
  const resizeOpts = {
    width: 1600,
    height: 1600,
    fit: "inside",
    withoutEnlargement: true,
  };
  let buf = await sharp(inputBuffer)
    .rotate() // авто-поворот по EXIF
    .resize(resizeOpts)
    .jpeg({ quality })
    .toBuffer();
  // Подбираем качество вниз, если не помещается
  while (buf.length > targetBytes && quality > 30) {
    quality -= 10;
    buf = await sharp(inputBuffer)
      .rotate()
      .resize(resizeOpts)
      .jpeg({ quality })
      .toBuffer();
  }
  // Если всё ещё великовато (очень редко) — уменьшаем разрешение
  if (buf.length > targetBytes) {
    buf = await sharp(inputBuffer)
      .rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 60 })
      .toBuffer();
  }
  return "data:image/jpeg;base64," + buf.toString("base64");
}

// Сохраняет фото в коллекцию photos (тот же формат, что и в CRM).
// Возвращает id документа (pid).
async function savePhotoToFirestore(dataUrl, meta) {
  const pid =
    "ph_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  await db.collection("photos").doc(pid).set({
    data: dataUrl,
    uploadedBy: meta.uploadedBy || "Telegram",
    uploadedAt: meta.uploadedAt || nowDT(),
    requestId: meta.requestId || null,
  });
  return pid;
}

// Сохраняет заявку и отправляет пользователю подтверждение с номером.
// Если описание пустое — подставляет осмысленную заглушку.
async function finalizeAndConfirm(chatId, sess) {
  if (!(sess.desc || "").trim()) {
    const hasPhotos = Array.isArray(sess.photos) && sess.photos.length > 0;
    sess.desc = hasPhotos ? "(см. фото)" : "(без описания)";
  }
  try {
    const displayNumber = await createRequest(sess, chatId);
    const photosCount = (sess.photos || []).length;
    await clearSession(chatId);
    await sendMessage(
      chatId,
      `✅ <b>Заявка принята!</b>\n\nНомер заявки: <b>${displayNumber}</b>\n` +
        `Адрес: ${sess.street}${sess.house ? ", д." + sess.house : ""}${
          sess.apart ? ", кв." + sess.apart : ""
        }\n` +
        `Тип: ${sess.type}` +
        (photosCount ? `\nФото: ${photosCount}` : "") +
        `\n\nДиспетчер обработает вашу заявку. Спасибо за обращение!`,
      { reply_markup: mainMenuKeyboard() }
    );
    return true;
  } catch (e) {
    console.error("createRequest error:", e.message);
    await sendMessage(
      chatId,
      "⚠️ Произошла ошибка при создании заявки. Попробуйте ещё раз позже или позвоните в диспетчерскую."
    );
    return false;
  }
}


async function handleUpdate(update) {
  // Нажатие на инлайн-кнопку
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message.chat.id;
    const data = cq.data;

    // Подтверждаем нажатие (убираем "часики")
    await tgCall("answerCallbackQuery", { callback_query_id: cq.id });

    // Отмена на любом шаге — чистим сессию, возвращаем в главное меню
    if (data === "cancel") {
      await clearSession(chatId);
      // На случай, если показана reply-клавиатура (телефон) — убираем её
      await sendMessage(chatId, "Отменено.", { reply_markup: removeKeyboard() });
      await sendMessage(chatId, "Выберите действие:", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    if (data === "new_request") {
      const addresses = await getAddresses();
      const streets = uniqueStreets(addresses);
      if (streets.length === 0) {
        // На случай, если адресов в базе нет — откатываемся на ручной ввод
        await setSession(chatId, { step: "address_manual" });
        await sendMessage(
          chatId,
          "📝 <b>Новая заявка</b>\n\nУкажите адрес: улицу, номер дома и квартиру.\n\nНапример: <i>ул. Ленина, д. 12, кв. 45</i>"
        );
        return;
      }
      await setSession(chatId, { step: "street" });
      await sendMessage(
        chatId,
        "📝 <b>Новая заявка</b>\n\nВыберите улицу:",
        { reply_markup: streetsKeyboard(streets) }
      );
      return;
    }

    if (data === "ai_assistant") {
      await sendMessage(
        chatId,
        "🤖 <b>ИИ-ассистент</b>\n\nПомощник скоро заработает. Сейчас идёт наполнение базы знаний.\n\nА пока вы можете подать заявку — нажмите кнопку ниже.",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    // Выбор улицы → показываем дома на ней
    if (data.startsWith("street:")) {
      const idx = parseInt(data.slice(7), 10);
      const addresses = await getAddresses();
      const streets = uniqueStreets(addresses);
      const street = streets[idx];
      if (!street) {
        await sendMessage(chatId, "Улица не найдена, попробуйте ещё раз: /start");
        return;
      }
      const sess = (await getSession(chatId)) || {};
      sess.street = street;
      sess.step = "house";
      await setSession(chatId, sess);
      await sendMessage(
        chatId,
        `Улица: <b>${street}</b>\n\nТеперь выберите дом:`,
        { reply_markup: housesKeyboard(addresses, street) }
      );
      return;
    }

    // Назад к списку улиц
    if (data === "back_streets") {
      const addresses = await getAddresses();
      const streets = uniqueStreets(addresses);
      await setSession(chatId, { step: "street" });
      await sendMessage(chatId, "Выберите улицу:", {
        reply_markup: streetsKeyboard(streets),
      });
      return;
    }

    // Выбор дома → просим ввести квартиру
    if (data.startsWith("house:")) {
      const id = parseInt(data.slice(6), 10);
      const addresses = await getAddresses();
      const addr = addresses.find((a) => a.id === id);
      if (!addr) {
        await sendMessage(chatId, "Дом не найден, попробуйте ещё раз: /start");
        return;
      }
      const sess = (await getSession(chatId)) || {};
      sess.street = addr.street;
      sess.house = addr.house;
      sess.step = "apart";
      await setSession(chatId, sess);
      await sendMessage(
        chatId,
        `Адрес: <b>${addr.street}, д. ${addr.house}</b>\n\nУкажите номер квартиры (просто напишите число). Если заявка по дому в целом (подъезд, двор) — напишите <b>—</b> (прочерк).\n\n<i>Чтобы отменить — /cancel</i>`
      );
      return;
    }

    // Выбор типа заявки (по индексу из актуального списка CRM)
    if (data.startsWith("type:")) {
      const idx = parseInt(data.slice(5), 10);
      const types = await getRequestTypes();
      const type = types[idx];
      if (!type) {
        await sendMessage(chatId, "Тип не найден, попробуйте заново: /start");
        return;
      }
      const sess = (await getSession(chatId)) || {};
      sess.type = type;
      sess.step = "step_photo";
      sess.photos = [];
      sess.desc = "";
      await setSession(chatId, sess);
      await sendMessage(
        chatId,
        `Тип: <b>${type}</b>\n\n📷 Прикрепите фото проблемы (до ${MAX_PHOTOS} шт.) — или нажмите <b>«✅ Продолжить»</b>.`,
        { reply_markup: continueKeyboard() }
      );
      return;
    }

    // Кнопка "Отправить заявку"
    // На шаге фото — переходим к шагу текста (не отправляем ещё)
    // На шаге текста — реально отправляем заявку
    if (data === "submit") {
      const sess = (await getSession(chatId)) || {};
      if (sess.step === "step_photo") {
        sess.step = "step_text";
        await setSession(chatId, sess);
        await sendMessage(
          chatId,
          "✏️ Теперь опишите проблему словами — или нажмите <b>«✅ Отправить заявку»</b>, если описание не нужно.",
          { reply_markup: submitKeyboard() }
        );
        return;
      }
      if (sess.step === "step_text") {
        await finalizeAndConfirm(chatId, sess);
        return;
      }
      await sendMessage(chatId, "Нет заявки в работе. /start чтобы начать.");
      return;
    }

    // Запрос обратного звонка → сразу просим телефон
    if (data === "callback_request") {
      await setSession(chatId, { step: "cb_phone" });
      await sendMessage(
        chatId,
        "📞 <b>Обратный звонок</b>\n\nОставьте номер телефона — диспетчер перезвонит.\n\nНажмите кнопку <b>«Поделиться контактом»</b> ниже, или напишите номер сообщением.\n\n<i>Чтобы отменить — /cancel</i>",
        { reply_markup: phoneKeyboard() }
      );
      return;
    }

    // "Отменить мою заявку" — показываем список активных заявок этого жильца
    if (data === "my_requests") {
      const myRequests = await getMyActiveRequests(chatId);
      if (myRequests.length === 0) {
        await sendMessage(
          chatId,
          "У вас нет активных заявок, которые можно отменить.",
          { reply_markup: mainMenuKeyboard() }
        );
        return;
      }
      const rows = myRequests.map((r) => [
        {
          text: `${r.displayNumber || "#" + r.id}\n${r.type || "—"}`,
          callback_data: "cancel_req:" + r.id,
        },
      ]);
      rows.push([{ text: "⬅️ В главное меню", callback_data: "cancel" }]);
      await sendMessage(
        chatId,
        "Ваши активные заявки. Нажмите на ту, которую нужно отменить:",
        { reply_markup: { inline_keyboard: rows } }
      );
      return;
    }

    // Подтверждение отмены конкретной заявки
    if (data.startsWith("cancel_req:")) {
      const id = parseInt(data.slice(11), 10);
      const req = await findRequestById(id);
      if (!req || req.tgChatId !== chatId) {
        await sendMessage(
          chatId,
          "Заявка не найдена. Возможно, она уже отменена.",
          { reply_markup: mainMenuKeyboard() }
        );
        return;
      }
      await sendMessage(
        chatId,
        `Отменить заявку <b>${req.displayNumber || "#" + req.id}</b> (${
          req.type || "—"
        })?\n\nЭто действие нельзя отменить.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Да, отменить", callback_data: "confirm_cancel:" + id }],
              [{ text: "⬅️ Назад к списку", callback_data: "my_requests" }],
            ],
          },
        }
      );
      return;
    }

    // Реальная отмена заявки (после подтверждения)
    if (data.startsWith("confirm_cancel:")) {
      const id = parseInt(data.slice(15), 10);
      const ok = await cancelRequestByUser(id, chatId);
      if (ok) {
        await sendMessage(
          chatId,
          `✅ Заявка <b>${ok.displayNumber || "#" + ok.id}</b> отменена.\n\nЕсли что-то понадобится — обращайтесь.`,
          { reply_markup: mainMenuKeyboard() }
        );
      } else {
        await sendMessage(
          chatId,
          "Не удалось отменить заявку. Возможно, она уже была отменена или закрыта.",
          { reply_markup: mainMenuKeyboard() }
        );
      }
      return;
    }
    return;
  }

  // Обычное сообщение
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || "").trim();

    // Команда /start — главное меню
    if (text === "/start") {
      await clearSession(chatId);
      await sendMessage(
        chatId,
        "👋 Здравствуйте! Это бот управляющей компании <b>Сириус</b>.\n\nЧем помочь?",
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    // Команда /cancel — отмена текущего действия, возврат в меню
    if (text === "/cancel") {
      await clearSession(chatId);
      await sendMessage(chatId, "Отменено.", { reply_markup: removeKeyboard() });
      await sendMessage(chatId, "Выберите действие:", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    const sess = await getSession(chatId);

    // Если пользователь не в диалоге — показываем меню
    if (!sess || !sess.step) {
      await sendMessage(chatId, "Выберите действие:", {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    // --- Шаг: ввод квартиры (после выбора улицы и дома кнопками) ---
    if (sess.step === "apart") {
      if (!text) {
        await sendMessage(chatId, "Пожалуйста, напишите номер квартиры (или «—», если заявка по дому).");
        return;
      }
      sess.apart = (text === "-" || text === "—") ? "" : text;
      sess.step = "phone";
      await setSession(chatId, sess);
      await sendMessage(
        chatId,
        "📱 Укажите номер телефона для связи.\n\nНажмите кнопку <b>«Поделиться контактом»</b> ниже, или просто напишите номер сообщением.\n\n<i>Чтобы отменить — /cancel</i>",
        { reply_markup: phoneKeyboard() }
      );
      return;
    }

    // --- Запасной шаг: ручной ввод адреса (если в базе нет адресов) ---
    if (sess.step === "address_manual") {
      if (!text) {
        await sendMessage(chatId, "Пожалуйста, напишите адрес текстом.");
        return;
      }
      sess.rawAddress = text;
      const houseM = text.match(/д\.?\s*([0-9]+[а-яА-Яa-zA-Z]?)/);
      const apartM = text.match(/кв\.?\s*([0-9]+[а-яА-Яa-zA-Z]?)/);
      let street = text;
      if (houseM) street = text.slice(0, houseM.index).replace(/[,;]\s*$/, "").trim();
      sess.street = street || text;
      sess.house = houseM ? houseM[1] : "";
      sess.apart = apartM ? apartM[1] : "";
      sess.step = "phone";
      await setSession(chatId, sess);
      await sendMessage(
        chatId,
        "📱 Укажите номер телефона для связи.\n\nНажмите кнопку <b>«Поделиться контактом»</b> ниже, или просто напишите номер сообщением.\n\n<i>Чтобы отменить — /cancel</i>",
        { reply_markup: phoneKeyboard() }
      );
      return;
    }

    // --- Шаг 2: телефон ---
    if (sess.step === "phone") {
      let phone = "";
      let name = "";
      if (msg.contact) {
        phone = msg.contact.phone_number || "";
        name = [msg.contact.first_name, msg.contact.last_name]
          .filter(Boolean)
          .join(" ");
      } else if (text) {
        phone = text;
      }
      if (!phone) {
        await sendMessage(
          chatId,
          "Не получилось распознать номер. Напишите его сообщением или нажмите кнопку «Поделиться контактом»."
        );
        return;
      }
      sess.phone = phone;
      // Имя берём из контакта, либо из профиля Telegram
      sess.name =
        name ||
        [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
        "Житель (Telegram)";
      sess.step = "type";
      await setSession(chatId, sess);
      await sendMessage(chatId, "Спасибо! Уберём клавиатуру.", {
        reply_markup: removeKeyboard(),
      });
      const types = await getRequestTypes();
      await sendMessage(chatId, "Выберите тип проблемы:", {
        reply_markup: typeKeyboard(types),
      });
      return;
    }

    // --- Шаг: телефон для обратного звонка → сразу создаём заявку на секретаря ---
    if (sess.step === "cb_phone") {
      let phone = "";
      let name = "";
      if (msg.contact) {
        phone = msg.contact.phone_number || "";
        name = [msg.contact.first_name, msg.contact.last_name]
          .filter(Boolean)
          .join(" ");
      } else if (text) {
        phone = text;
      }
      if (!phone) {
        await sendMessage(
          chatId,
          "Не получилось распознать номер. Напишите его сообщением или нажмите кнопку «Поделиться контактом»."
        );
        return;
      }
      const secId = await getSecretaryId();
      const cbSess = {
        name:
          name ||
          [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
          "Житель (Telegram)",
        phone,
        street: "",
        house: "",
        apart: "",
        type: "Обратный звонок",
        desc: "Запрос обратного звонка через бота",
        assignee: secId || null,
      };
      let number = null;
      try {
        number = await createRequest(cbSess, chatId);
      } catch (e) {
        console.error("createRequest (callback) error:", e.message);
      }
      await clearSession(chatId);
      await sendMessage(chatId, "Спасибо! Уберём клавиатуру.", {
        reply_markup: removeKeyboard(),
      });
      await sendMessage(
        chatId,
        `✅ <b>Заявка на обратный звонок принята!</b>${
          number ? "\nНомер заявки: <b>" + number + "</b>" : ""
        }\n\nДиспетчер перезвонит вам в ближайшее время по номеру: ${phone}`,
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    // --- Шаг 1: фото (или сразу Продолжить) ---
    if (sess.step === "step_photo") {
      // Получаем file_id из photo (камера/галерея) ИЛИ из document, если это картинка
      // (так Telegram-десктоп на Mac отправляет, когда перетаскиваешь файл)
      let fileId = null;
      let fileSize = 0;
      let kind = null;
      if (Array.isArray(msg.photo) && msg.photo.length > 0) {
        const best = msg.photo[msg.photo.length - 1];
        fileId = best.file_id;
        fileSize = best.file_size || 0;
        kind = "photo";
      } else if (
        msg.document &&
        typeof msg.document.mime_type === "string" &&
        msg.document.mime_type.startsWith("image/")
      ) {
        fileId = msg.document.file_id;
        fileSize = msg.document.file_size || 0;
        kind = "document";
      }

      if (fileId) {
        if (!Array.isArray(sess.photos)) sess.photos = [];
        if (sess.photos.length >= MAX_PHOTOS) {
          sess.step = "step_text";
          await setSession(chatId, sess);
          await sendMessage(
            chatId,
            `Уже ${MAX_PHOTOS} фото — это максимум.\n\n✏️ Опишите проблему словами или нажмите <b>«✅ Отправить заявку»</b>.`,
            { reply_markup: submitKeyboard() }
          );
          return;
        }
        // Telegram-бот может скачивать файлы до 20 МБ — это аппаратный лимит API.
        // Всё, что меньше — мы потом сожмём сами через sharp.
        if (fileSize && fileSize > 20 * 1024 * 1024) {
          await sendMessage(
            chatId,
            `⚠️ Файл слишком большой (${Math.round(fileSize / (1024 * 1024))} МБ). Максимум — 20 МБ. Попробуйте отправить как обычное фото (без «как файл») или сделать снимок меньше.`,
            { reply_markup: continueKeyboard() }
          );
          return;
        }
        try {
          const inputBuf = await downloadTgFileAsBuffer(fileId);
          const dataUrl = await compressImageToDataUrl(inputBuf);
          const pid = await savePhotoToFirestore(dataUrl, {
            uploadedBy: "Telegram",
            uploadedAt: nowDT(),
          });
          sess.photos.push(pid);
          if (sess.photos.length >= MAX_PHOTOS) {
            sess.step = "step_text";
            await setSession(chatId, sess);
            await sendMessage(
              chatId,
              `📷 Фото ${sess.photos.length} из ${MAX_PHOTOS} принято — это максимум.\n\n✏️ Теперь опишите проблему словами или нажмите <b>«✅ Отправить заявку»</b>.`,
              { reply_markup: submitKeyboard() }
            );
          } else {
            await setSession(chatId, sess);
            await sendMessage(
              chatId,
              `📷 Фото ${sess.photos.length} из ${MAX_PHOTOS} принято.`,
              { reply_markup: continueKeyboard() }
            );
          }
        } catch (e) {
          console.error("photo save error:", e.message);
          await sendMessage(
            chatId,
            "⚠️ Не удалось сохранить фото. Попробуйте ещё раз или отправьте меньший снимок.",
            { reply_markup: continueKeyboard() }
          );
        }
        return;
      }

      // Документ-не-картинка (PDF и т.п.) — отвергаем с понятным сообщением
      if (msg.document) {
        await sendMessage(
          chatId,
          "⚠️ Это не картинка. Можно прикрепить только фото проблемы (JPG/PNG).",
          { reply_markup: continueKeyboard() }
        );
        return;
      }

      // Текст на шаге фото не принимаем — для него будет следующий шаг
      if (text) {
        await sendMessage(
          chatId,
          "Сейчас шаг для фото. Описание сможете добавить после — нажмите <b>«✅ Продолжить»</b>.",
          { reply_markup: continueKeyboard() }
        );
        return;
      }

      // Что-то иное (стикер, голосовое)
      await sendMessage(
        chatId,
        "Пришлите <b>фото</b> или нажмите <b>«✅ Продолжить»</b>.",
        { reply_markup: continueKeyboard() }
      );
      return;
    }

    // --- Шаг 2: текст (или сразу Отправить) ---
    if (sess.step === "step_text") {
      // Любой текст — сразу сохраняем как описание и отправляем заявку
      if (text) {
        sess.desc = text;
        await finalizeAndConfirm(chatId, sess);
        return;
      }

      // Фото на этом шаге не принимаем — шаг фото уже пройден
      const isPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
      const isImgDoc =
        msg.document &&
        typeof msg.document.mime_type === "string" &&
        msg.document.mime_type.startsWith("image/");
      if (isPhoto || isImgDoc) {
        await sendMessage(
          chatId,
          "Шаг фото уже пройден. Опишите проблему текстом или нажмите <b>«✅ Отправить заявку»</b>.",
          { reply_markup: submitKeyboard() }
        );
        return;
      }

      // Что-то иное
      await sendMessage(
        chatId,
        "Пришлите <b>текст</b> с описанием или нажмите <b>«✅ Отправить заявку»</b>.",
        { reply_markup: submitKeyboard() }
      );
      return;
    }
  }
}

// ====== Точка входа: webhook от Telegram ======
exports.bot = onRequest(
  {
    secrets: [BOT_TOKEN],
    region: "us-central1",
    memory: "512MiB", // достаточно для sharp на больших фото
    timeoutSeconds: 60,
  },
  async (req, res) => {
  // Telegram шлёт POST с обновлением
  if (req.method !== "POST") {
    res.status(200).send("Sirius bot is running.");
    return;
  }
  console.log("=== Incoming update ===", JSON.stringify(req.body).slice(0, 500));
  try {
    await handleUpdate(req.body);
    console.log("=== handleUpdate finished OK ===");
  } catch (e) {
    console.error("handleUpdate error:", e.message, e.stack);
  }
  // Telegram важно получить 200 OK быстро
  res.status(200).send("ok");
});
