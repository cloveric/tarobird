// Small, transactionally maintained accounting; never SUM historical bodies on
// the minute maintenance path. Backfill of pre-existing rows is resumable.
export const EVENT_HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS event_history_state(id INTEGER PRIMARY KEY CHECK(id=1), scanned_rowid INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, rows INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO event_history_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS event_history(conversation_id TEXT NOT NULL,seq INTEGER NOT NULL,at INTEGER NOT NULL,bytes INTEGER NOT NULL,message_id TEXT,PRIMARY KEY(conversation_id,seq)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS event_history_age ON event_history(at,conversation_id,seq);
CREATE TABLE IF NOT EXISTS event_history_floor(conversation_id TEXT PRIMARY KEY,seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS event_history_account_insert AFTER INSERT ON event_history BEGIN
 UPDATE event_history_state SET rows=rows+1,bytes=bytes+NEW.bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS event_history_account_delete AFTER DELETE ON event_history BEGIN
 UPDATE event_history_state SET rows=rows-1,bytes=bytes-OLD.bytes WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS event_history_insert AFTER INSERT ON events WHEN NEW.kind='message.updated' BEGIN
 INSERT OR IGNORE INTO event_history VALUES(NEW.conversation_id,NEW.seq,NEW.at,length(CAST(NEW.payload_json AS BLOB)),CASE WHEN json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.id') END);
END;
CREATE TRIGGER IF NOT EXISTS event_history_update AFTER UPDATE ON events BEGIN
 DELETE FROM event_history WHERE conversation_id=OLD.conversation_id AND seq=OLD.seq;
 INSERT INTO event_history SELECT NEW.conversation_id,NEW.seq,NEW.at,length(CAST(NEW.payload_json AS BLOB)),CASE WHEN json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.id') END WHERE NEW.kind='message.updated';
END;
CREATE TRIGGER IF NOT EXISTS event_history_delete AFTER DELETE ON events BEGIN
 DELETE FROM event_history WHERE conversation_id=OLD.conversation_id AND seq=OLD.seq;
END;
`;
// A retained creation/read/reaction event may precede a removed update. MIN(seq)
// alone is no longer a replay boundary. Schema 22 fences unaware old Hosts.
export const replayHeadSql = `SELECT COALESCE(MAX(seq),0) AS seq,
 max(COALESCE(MIN(seq),0),COALESCE((SELECT seq+1 FROM event_history_floor WHERE conversation_id=?1),0)) AS firstSeq
 FROM events WHERE conversation_id=?1`;
