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

function unique(values) {
  return [
    ...new Set(
      values.map((value) => scalar(value)).filter(Boolean),
    ),
  ];
}

export function directoryEntriesFromContacts(body, sourceId) {
  return contactList(body).flatMap((contact) => {
    const id = scalar(
      contact?.UserName ??
        contact?.userName ??
        contact?.username ??
        contact?.wxid,
    );
    if (!id) return [];
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
      contact?.pyInitial,
      contact?.QuanPin,
      contact?.quanPin,
    ]);
    const entityType = id.endsWith("@chatroom")
      ? "group"
      : Number.isFinite(verifyFlag) && (verifyFlag & 8) !== 0
        ? "official"
        : "user";
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
