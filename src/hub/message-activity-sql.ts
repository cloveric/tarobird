// Leaf module: imported by database.ts (schema) and message-activity.ts (repair).
// Keep it free of runtime imports so the schema can be evaluated in any order.

const MESSAGE_KINDS = "('message.created','message.updated')";
// Invalid or unexpected payloads produce NULL fields; they never fail the event
// insert that fires the trigger. Every derivation path uses these expressions.
const messageField = (payload: string, kind: string, path: string) =>
  `CASE WHEN ${kind} IN ${MESSAGE_KINDS} AND json_valid(${payload}) THEN json_extract(${payload},'${path}') END`;
const hideField = (payload: string, kind: string, path: string) =>
  `CASE WHEN ${kind}='message.deleted' AND json_valid(${payload}) THEN json_extract(${payload},'${path}') END`;

/** Small fields extracted from one journal event. */
export const activityEventColumns = (payload: string, kind: string) => [
  `${messageField(payload, kind, "$.id")} AS message_id`,
  `${messageField(payload, kind, "$.authorType")} AS author`,
  `${messageField(payload, kind, "$.status")} AS status`,
  `${hideField(payload, kind, "$.userId")} AS hide_user`,
  `${hideField(payload, kind, "$.message.id")} AS hide_message`,
].join(",");

/** Bound source row for repair: ?1 conversation, ?2 seq, ?3 at, ?4 message, ?5 author, ?6 status, ?7 hide user, ?8 hide message. */
export const ACTIVITY_PARAMETER_SOURCE = "SELECT ?1 AS conversation_id,?2 AS seq,?3 AS at,?4 AS message_id,?5 AS author,?6 AS status,?7 AS hide_user,?8 AS hide_message";

// One per-message fold, shared by the trigger and bounded repair. Events of one
// message arrive in sequence order; the guarded update keeps the fold idempotent.
// contentSeq/contentAt derive from first_* (user) or last_* (others); unread_seq
// records the latest Bot transition from no earlier event/pending/streaming
// into complete/error, exactly as the former journal window query did.
export const foldActivitySql = (source: string) => `INSERT INTO message_activity(conversation_id,message_id,author,first_seq,first_at,last_seq,last_at,last_status,unread_seq)
  SELECT e.conversation_id,e.message_id,e.author,e.seq,e.at,e.seq,e.at,e.status,CASE WHEN e.author='bot' AND e.status IN ('complete','error') THEN e.seq ELSE 0 END
  FROM (${source}) AS e WHERE e.message_id IS NOT NULL
  ON CONFLICT(conversation_id,message_id) DO UPDATE SET
    unread_seq=CASE WHEN excluded.author='bot' AND excluded.last_status IN ('complete','error') AND (message_activity.last_status IS NULL OR message_activity.last_status IN ('pending','streaming')) THEN excluded.last_seq ELSE message_activity.unread_seq END,
    last_seq=excluded.last_seq,last_at=excluded.last_at,last_status=excluded.last_status
  WHERE excluded.last_seq>message_activity.last_seq`;
export const foldHideSql = (source: string) => `INSERT OR IGNORE INTO message_hide_events(conversation_id,seq,user_id,message_id)
  SELECT e.conversation_id,e.seq,e.hide_user,e.hide_message FROM (${source}) AS e WHERE e.hide_user IS NOT NULL AND e.hide_message IS NOT NULL`;

const triggerSource = `SELECT NEW.conversation_id AS conversation_id,NEW.seq AS seq,NEW.at AS at,${activityEventColumns("NEW.payload_json", "NEW.kind")}`;

/** Derived, rebuildable metadata. Additive: older Hubs ignore the tables, while
 * the triggers keep folding their writes. A conversation is covered through
 * conversation_activity.through_seq; the event trigger only advances an exact
 * next sequence, so lagging/missing coverage is detected and repaired instead. */
export const MESSAGE_ACTIVITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS message_activity (conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, author TEXT, first_seq INTEGER NOT NULL, first_at INTEGER NOT NULL, last_seq INTEGER NOT NULL, last_at INTEGER NOT NULL, last_status TEXT, unread_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,message_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS message_activity_changes ON message_activity(conversation_id,last_seq);
CREATE TABLE IF NOT EXISTS message_hide_events (conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(conversation_id,seq)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS conversation_activity (conversation_id TEXT PRIMARY KEY, through_seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS conversations_message_activity_v1 AFTER INSERT ON conversations
BEGIN
  INSERT OR IGNORE INTO conversation_activity(conversation_id,through_seq) VALUES(NEW.id,0);
END;
CREATE TRIGGER IF NOT EXISTS events_message_activity_v1 AFTER INSERT ON events
WHEN NEW.seq=(SELECT through_seq+1 FROM conversation_activity WHERE conversation_id=NEW.conversation_id)
BEGIN
  ${foldActivitySql(triggerSource)};
  ${foldHideSql(triggerSource)};
  UPDATE conversation_activity SET through_seq=NEW.seq WHERE conversation_id=NEW.conversation_id;
END;
`;
