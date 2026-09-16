function scalar(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (typeof value === "object") {
    return scalar(
      value.string ??
        value.String ??
        value.value ??
        value.Value ??
        value.str ??
        value.id,
    );
  }
  return "";
}

function contactList(body) {
  const data = body?.Data ?? body?.data ?? body?.response ?? body;
  const contacts =
    data?.ContactList ??
    data?.contactList ??
    data?.contacts ??
    body?.ContactList ??
    body?.contactList;
  if (Array.isArray(contacts)) return contacts;
  return [];
}

function dataObject(body) {
  return body?.Data ?? body?.data ?? body?.response ?? body ?? {};
}

function unique(values) {
  return [
    ...new Set(
      values.map((value) => scalar(value)).filter(Boolean),
    ),
  ];
}

const SYSTEM_CONTACT_IDS = new Set([
  "blogapp",
  "brandsessionholder",
  "facebookapp",
  "feedsapp",
  "filehelper",
  "floatbottle",
  "fmessage",
  "helper_entry",
  "lbsapp",
  "masssendapp",
  "medianote",
  "newsapp",
  "notification_messages",
  "officialaccounts",
  "qmessage",
  "qqmail",
  "shakeapp",
  "tmessage",
  "voip",
  "voipapp",
  "weixin",
  "weixinreminder",
]);

export function directoryContactIds(body) {
  const data = dataObject(body);
  const values =
    data?.ContactUsernameList ??
    data?.contactUsernameList ??
    data?.contact_user_name_list ??
    body?.ContactUsernameList ??
    body?.contactUsernameList ??
    [];
  if (!Array.isArray(values)) return [];
  return unique(values);
}

export function directoryContactCursor(body) {
  const data = dataObject(body);
  return {
    continue: Number(scalar(
      data?.CountinueFlag ??
        data?.ContinueFlag ??
        data?.countinueFlag ??
        data?.continueFlag,
    )) !== 0,
    wxContactSeq: Number(scalar(
      data?.CurrentWxcontactSeq ??
        data?.CurrentWxContactSeq ??
        data?.currentWxcontactSeq ??
        data?.currentWxContactSeq,
    )) || 0,
    chatRoomSeq: Number(scalar(
      data?.CurrentChatRoomContactSeq ??
        data?.currentChatRoomContactSeq,
    )) || 0,
  };
}

export function isDirectoryContactId(value) {
  const id = scalar(value);
  if (!id) return false;
  if (id.endsWith("@chatroom")) return true;
  const normalized = id.toLowerCase();
  return !normalized.startsWith("gh_") && !SYSTEM_CONTACT_IDS.has(normalized);
}

export function directoryEntriesFromContacts(body, sourceId) {
  return contactList(body).flatMap((contact) => {
    const id = scalar(
      contact?.UserName ??
        contact?.userName ??
        contact?.username ??
        contact?.wxid,
    );
    if (!isDirectoryContactId(id)) return [];
    const verifyFlag = Number(
      scalar(
        contact?.VerifyFlag ??
          contact?.verifyFlag ??
          contact?.verify_flag,
      ),
    );
    const names = unique([
      contact?.Remark,
      contact?.remark,
      contact?.NickName,
      contact?.nickName,
      contact?.nickname,
      contact?.Alias,
      contact?.alias,
      contact?.PYInitial,
      contact?.Pyinitial,
      contact?.pyInitial,
      contact?.QuanPin,
      contact?.quanPin,
    ]);
    const entityType = id.endsWith("@chatroom")
      ? "group"
      : Number.isFinite(verifyFlag) && (verifyFlag & 8) !== 0
        ? "official"
        : "user";
    if (entityType === "official") return [];
    return [{
      sourceId,
      entityType,
      entityId: id,
      displayName: names[0] || "",
      searchNames: names,
      origin: "contacts",
    }];
  });
}
