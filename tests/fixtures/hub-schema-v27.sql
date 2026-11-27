-- Schema-only export from a Hub initialized by main 2510c743 (#142).
-- SQLite creates its internal sequences and FTS shadow tables automatically.
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE run_journal (
 message_id TEXT NOT NULL, run_id TEXT NOT NULL, bot_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(message_id,run_id,seq)
);
CREATE INDEX run_journal_expiry ON run_journal(updated_at);
CREATE TABLE run_journal_scoped (
 message_id TEXT NOT NULL, run_id TEXT NOT NULL, bot_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, scope_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(message_id,run_id,seq)
);
CREATE INDEX run_journal_scoped_expiry ON run_journal_scoped(updated_at);
CREATE TABLE agent_buses (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, revision TEXT NOT NULL, config_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE agent_bus_requests (owner_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL, result_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,request_id));
CREATE TABLE agent_bus_runs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, coordinator_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, snapshot_json TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, error TEXT, stop_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX agent_bus_runs_workspace ON agent_bus_runs(workspace_id,created_at);
CREATE INDEX agent_bus_runs_status ON agent_bus_runs(status);
CREATE TABLE agent_bus_stages (run_id TEXT NOT NULL, id TEXT NOT NULL, bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, status TEXT NOT NULL, message_id TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT, seq INTEGER NOT NULL, PRIMARY KEY(run_id,id));
CREATE TABLE group_discussion_settings (group_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('designated','mentions','parallel','sequential','independent')), order_json TEXT NOT NULL, max_rounds INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE group_discussions (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, conversation_id TEXT NOT NULL, topic_message_id TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL, settings_revision TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('sequential','independent')), participants_json TEXT NOT NULL, left_json TEXT NOT NULL DEFAULT '[]', max_rounds INTEGER NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('blind','discussion')), round INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','pausing','paused','ending','completed','ended','failed')), pause_reason TEXT, pause_turn_id TEXT, outcome TEXT, conclusion TEXT, proposal_json TEXT, proposal_seq INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
CREATE UNIQUE INDEX group_discussions_active ON group_discussions(group_id) WHERE status IN ('running','pausing','paused','ending');
CREATE INDEX group_discussions_conversation ON group_discussions(conversation_id,created_at);
CREATE TABLE group_discussion_turns (id TEXT PRIMARY KEY, discussion_id TEXT NOT NULL, seq INTEGER NOT NULL, round INTEGER NOT NULL, position INTEGER NOT NULL, attempt INTEGER NOT NULL, bot_id TEXT NOT NULL, blind INTEGER NOT NULL, input_message_id TEXT NOT NULL UNIQUE, context_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','settled')), result TEXT, acknowledged INTEGER NOT NULL DEFAULT 0, report_text TEXT, report_truncated INTEGER NOT NULL DEFAULT 0, stance_json TEXT, stop_requested INTEGER NOT NULL DEFAULT 0, stop_sent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, settled_at INTEGER, attention TEXT, started INTEGER NOT NULL DEFAULT 0, UNIQUE(discussion_id,seq), UNIQUE(discussion_id,round,position,attempt));
CREATE INDEX group_discussion_turns_active ON group_discussion_turns(bot_id,state);
CREATE TABLE group_discussion_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL, result_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id));
CREATE TABLE group_session_members (
  conversation_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  host_public_key TEXT,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_title TEXT NOT NULL,
  name_snapshot TEXT NOT NULL,
  avatar_snapshot TEXT,
  engine_snapshot TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  joined_after_seq INTEGER NOT NULL,
  history_visibility_json TEXT NOT NULL,
  history_backfilled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  removed_at INTEGER,
  PRIMARY KEY (conversation_id, member_key, session_id)
);
CREATE INDEX group_session_members_group_active ON group_session_members(group_id, active);
CREATE TABLE group_former_sessions (
  conversation_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, session_id)
);
CREATE INDEX group_former_sessions_group ON group_former_sessions(group_id, revoked_at);
CREATE TABLE group_designated_member (
  group_id TEXT PRIMARY KEY,
  member_key TEXT NOT NULL
);
CREATE TABLE group_remote_questions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  host_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  host_public_key TEXT,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  bot_name_snapshot TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  stopped_unanswered INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  answered_at INTEGER,
  answer_message_id TEXT
);
CREATE INDEX group_remote_questions_group ON group_remote_questions(group_id, created_at);
CREATE INDEX group_remote_questions_source ON group_remote_questions(conversation_id, source_message_id, member_key);
CREATE INDEX group_remote_questions_sending ON group_remote_questions(created_at) WHERE status='sending' AND answer_message_id IS NULL;
CREATE TABLE group_mail_inbox (
  request_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_host_id TEXT NOT NULL,
  source_host_name TEXT NOT NULL,
  source_public_key TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  delivered_message_id TEXT NOT NULL,
  reply_message_id TEXT,
  reply_text TEXT,
  status TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  answered_at INTEGER,
  reply_forwarded INTEGER NOT NULL DEFAULT 0,
  reply_attempts INTEGER NOT NULL DEFAULT 0,
  reply_next_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX group_mail_inbox_delivered ON group_mail_inbox(delivered_message_id);
CREATE TABLE group_mail_nonces (
  source_public_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (source_public_key, nonce)
);
CREATE INDEX group_mail_nonces_expiry ON group_mail_nonces(expires_at);
CREATE TABLE profile_avatars (kind TEXT NOT NULL CHECK(kind IN ('user','bot','group')), target_id TEXT NOT NULL, revision INTEGER NOT NULL, png BLOB, PRIMARY KEY(kind,target_id));
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','member')));
CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, platform TEXT NOT NULL, public_key TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, push_json TEXT);
CREATE TABLE device_preferences (device_id TEXT PRIMARY KEY REFERENCES devices(id), preferences_json TEXT NOT NULL);
CREATE TABLE device_notification_options (device_id TEXT PRIMARY KEY REFERENCES devices(id), options_json TEXT NOT NULL);
CREATE TABLE push_bindings (device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE, provider TEXT NOT NULL, revision TEXT NOT NULL);
CREATE TABLE pairing_requests (code_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, platform TEXT NOT NULL, public_key TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, secret_hash TEXT NOT NULL, engine TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', effort TEXT NOT NULL DEFAULT '', online INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, role TEXT NOT NULL DEFAULT '', workspace_path TEXT);
CREATE TABLE managed_bots (bot_id TEXT PRIMARY KEY REFERENCES bots(id), owner_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, specification_json TEXT NOT NULL, UNIQUE(owner_id,request_id));
CREATE TABLE bot_grants (user_id TEXT NOT NULL REFERENCES users(id), bot_id TEXT NOT NULL REFERENCES bots(id), PRIMARY KEY(user_id,bot_id));
CREATE TABLE history_operations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, bot_id TEXT NOT NULL, source_conversation_id TEXT NOT NULL, expected_revision TEXT NOT NULL, action_json TEXT NOT NULL, anchor_json TEXT, destination_conversation_id TEXT, state TEXT NOT NULL, native_result_json TEXT, result_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner_id,request_id));
CREATE INDEX history_operations_source ON history_operations(source_conversation_id,state);
CREATE INDEX history_operations_destination ON history_operations(destination_conversation_id,state);
CREATE TABLE history_anchors (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, generation TEXT NOT NULL, revision TEXT NOT NULL, session_id TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(bot_id,message_id,generation));
CREATE INDEX history_anchors_page ON history_anchors(bot_id,conversation_id,id);
CREATE TABLE conversations (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('direct','group')), title TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), session_id TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, client_action_id TEXT, history_origin_json TEXT, parent_id TEXT REFERENCES conversations(id), binding_id TEXT, hidden INTEGER NOT NULL DEFAULT 0, ticket_json TEXT, workspace_path TEXT, UNIQUE(owner_id,client_action_id));
CREATE TABLE conversation_members (conversation_id TEXT NOT NULL REFERENCES conversations(id), member_type TEXT NOT NULL CHECK(member_type IN ('user','bot')), member_id TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,member_type,member_id));
CREATE TABLE events (conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(conversation_id,seq));
CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), author_id TEXT NOT NULL, author_type TEXT NOT NULL, blocks_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, client_msg_id TEXT, reply_to TEXT, created_at INTEGER NOT NULL, history_json TEXT, bot_source_json TEXT, discussion_json TEXT, workbench_receipt_json TEXT, mentions_json TEXT NOT NULL DEFAULT '[]', forwarded_json TEXT, preview_url TEXT, link_preview_json TEXT, preview_style TEXT, UNIQUE(author_id,client_msg_id));
CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, conversation_id UNINDEXED, body, tokenize='trigram');
CREATE TABLE attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), owner_id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, name TEXT NOT NULL, stored_name TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE attachment_recording (attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE, recording INTEGER NOT NULL CHECK(recording IN (0,1)));
CREATE TABLE retired_attachments (attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE);
CREATE TABLE upload_chunks (attachment_id TEXT NOT NULL REFERENCES attachments(id), chunk_index INTEGER NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(attachment_id,chunk_index));
CREATE TABLE message_deletions (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, deleted_at INTEGER NOT NULL, PRIMARY KEY(user_id,message_id));
CREATE INDEX message_deletions_message ON message_deletions(message_id,user_id);
CREATE TABLE message_attachments (message_id TEXT NOT NULL REFERENCES messages(id), attachment_id TEXT NOT NULL REFERENCES attachments(id), PRIMARY KEY(message_id,attachment_id));
CREATE INDEX message_attachments_attachment ON message_attachments(attachment_id);
CREATE TABLE bot_message_upload_permits (permit_key TEXT PRIMARY KEY REFERENCES meta(key) ON DELETE CASCADE, attachment_id TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)));
CREATE INDEX bot_message_upload_permits_attachment ON bot_message_upload_permits(attachment_id);
CREATE INDEX bot_message_upload_permits_unused ON bot_message_upload_permits(used,attachment_id);
CREATE TRIGGER bot_message_upload_permits_used AFTER INSERT ON message_attachments
 BEGIN UPDATE bot_message_upload_permits SET used=1 WHERE attachment_id=NEW.attachment_id AND used=0; END;
CREATE TABLE reads (user_id TEXT NOT NULL REFERENCES users(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL, PRIMARY KEY(user_id,conversation_id));
CREATE TABLE actions (user_id TEXT NOT NULL, client_action_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(user_id,client_action_id));
CREATE TABLE action_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_action_id TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), params_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result_json TEXT, created_at INTEGER NOT NULL, UNIQUE(user_id,client_action_id), FOREIGN KEY(user_id,client_action_id) REFERENCES actions(user_id,client_action_id));
CREATE TABLE deliveries (message_id TEXT NOT NULL REFERENCES messages(id), bot_id TEXT NOT NULL REFERENCES bots(id), status TEXT NOT NULL DEFAULT 'pending', queue_position INTEGER NOT NULL DEFAULT 0, dispatched INTEGER NOT NULL DEFAULT 0, queue_paused INTEGER NOT NULL DEFAULT 0 CHECK(queue_paused IN (0,1)), PRIMARY KEY(message_id,bot_id));
CREATE TABLE prompt_queue_workers (bot_id TEXT PRIMARY KEY REFERENCES bots(id), supported INTEGER NOT NULL);
CREATE TABLE conversation_batch_requests (user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
CREATE TABLE prompt_queue_mutations (user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY(user_id,request_id));
CREATE TABLE push_outbox (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), conversation_id TEXT NOT NULL, event_seq INTEGER NOT NULL, payload_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', next_at INTEGER NOT NULL, notice_class TEXT, UNIQUE(device_id,conversation_id,event_seq));
CREATE INDEX push_outbox_pending ON push_outbox(status,next_at);
CREATE INDEX push_outbox_device_pending ON push_outbox(device_id,status);
CREATE TABLE push_receipts (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE);
CREATE INDEX push_receipts_device ON push_receipts(device_id);
CREATE INDEX push_receipts_message ON push_receipts(message_id);
CREATE TRIGGER push_outbox_receipt_guard BEFORE INSERT ON push_outbox
 WHEN EXISTS(SELECT 1 FROM push_receipts WHERE id=NEW.id)
 BEGIN SELECT RAISE(IGNORE); END;
CREATE INDEX action_deliveries_pending ON action_deliveries(bot_id,status,created_at);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT, kind TEXT NOT NULL, detail_json TEXT NOT NULL);
CREATE INDEX messages_conversation ON messages(conversation_id,created_at);
CREATE INDEX messages_bot_replies ON messages(conversation_id,reply_to,author_id,created_at,id) WHERE author_type='bot' AND status!='deleted';
CREATE INDEX messages_active_bot_turns ON messages(created_at) WHERE author_type='bot' AND status IN ('pending','streaming');
CREATE INDEX messages_personal_history ON messages(conversation_id) WHERE status!='deleted';
CREATE INDEX attachments_conversation ON attachments(conversation_id);
CREATE TABLE dispatcher_settings (bot_id TEXT PRIMARY KEY REFERENCES bots(id), settings_json TEXT NOT NULL, revision TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE dispatch_tickets (id TEXT PRIMARY KEY, dispatcher_bot_id TEXT NOT NULL REFERENCES bots(id), conversation_id TEXT NOT NULL REFERENCES conversations(id), request_id TEXT NOT NULL, title TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, attempts_json TEXT NOT NULL DEFAULT '[]', result TEXT, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(dispatcher_bot_id,request_id));
CREATE INDEX dispatch_tickets_status ON dispatch_tickets(dispatcher_bot_id,status);
CREATE INDEX dispatch_tickets_sweep ON dispatch_tickets(status,id);
CREATE TABLE dispatch_ticket_removals (ticket_id TEXT PRIMARY KEY REFERENCES dispatch_tickets(id) ON DELETE CASCADE, removed_at INTEGER NOT NULL);
CREATE TABLE dispatch_requests (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(actor_id,request_id));
CREATE TABLE engine_health (engine TEXT PRIMARY KEY, state TEXT NOT NULL, until INTEGER, reason TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE dispatch_workers (dispatcher_bot_id TEXT NOT NULL REFERENCES bots(id), engine TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id), PRIMARY KEY(dispatcher_bot_id,engine));
CREATE TABLE dispatch_assists (id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES dispatch_tickets(id), worker_bot_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
  parent_attempt_id TEXT NOT NULL, parent_json TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, text TEXT NOT NULL, note TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('requested','starting','running','returned','cancelled')), child_attempt_id TEXT, continuation_attempt_id TEXT, outcome TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(worker_bot_id,request_id));
CREATE INDEX dispatch_assists_ticket ON dispatch_assists(ticket_id,created_at);
CREATE INDEX dispatch_assists_parent ON dispatch_assists(parent_attempt_id);
CREATE INDEX dispatch_assists_child ON dispatch_assists(child_attempt_id) WHERE child_attempt_id IS NOT NULL;
CREATE INDEX dispatch_assists_continuation ON dispatch_assists(continuation_attempt_id) WHERE continuation_attempt_id IS NOT NULL;
CREATE TABLE dispatch_assist_windows (ticket_id TEXT PRIMARY KEY REFERENCES dispatch_tickets(id), attempt_id TEXT NOT NULL, remaining INTEGER NOT NULL);
CREATE TABLE saved_workspaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, UNIQUE(owner_id,path));
CREATE INDEX saved_workspaces_owner ON saved_workspaces(owner_id,last_used_at DESC,created_at DESC);
CREATE TABLE message_activity (conversation_id TEXT NOT NULL, message_id TEXT NOT NULL, author TEXT, first_seq INTEGER NOT NULL, first_at INTEGER NOT NULL, last_seq INTEGER NOT NULL, last_at INTEGER NOT NULL, last_status TEXT, unread_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id,message_id)) WITHOUT ROWID;
CREATE INDEX message_activity_changes ON message_activity(conversation_id,last_seq);
CREATE TABLE message_hide_events (conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(conversation_id,seq)) WITHOUT ROWID;
CREATE TABLE conversation_activity (conversation_id TEXT PRIMARY KEY, through_seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE TRIGGER conversations_message_activity_v1 AFTER INSERT ON conversations
BEGIN
  INSERT OR IGNORE INTO conversation_activity(conversation_id,through_seq) VALUES(NEW.id,0);
END;
CREATE TRIGGER events_message_activity_v1 AFTER INSERT ON events
WHEN NEW.seq=(SELECT through_seq+1 FROM conversation_activity WHERE conversation_id=NEW.conversation_id)
BEGIN
  INSERT INTO message_activity(conversation_id,message_id,author,first_seq,first_at,last_seq,last_at,last_status,unread_seq)
  SELECT e.conversation_id,e.message_id,e.author,e.seq,e.at,e.seq,e.at,e.status,CASE WHEN e.author='bot' AND e.status IN ('complete','error') THEN e.seq ELSE 0 END
  FROM (SELECT NEW.conversation_id AS conversation_id,NEW.seq AS seq,NEW.at AS at,CASE WHEN NEW.kind IN ('message.created','message.updated') AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.id') END AS message_id,CASE WHEN NEW.kind IN ('message.created','message.updated') AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.authorType') END AS author,CASE WHEN NEW.kind IN ('message.created','message.updated') AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.status') END AS status,CASE WHEN NEW.kind='message.deleted' AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.userId') END AS hide_user,CASE WHEN NEW.kind='message.deleted' AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.message.id') END AS hide_message) AS e WHERE e.message_id IS NOT NULL
  ON CONFLICT(conversation_id,message_id) DO UPDATE SET
    unread_seq=CASE WHEN excluded.author='bot' AND excluded.last_status IN ('complete','error') AND (message_activity.last_status IS NULL OR message_activity.last_status IN ('pending','streaming')) THEN excluded.last_seq ELSE message_activity.unread_seq END,
    last_seq=excluded.last_seq,last_at=excluded.last_at,last_status=excluded.last_status
  WHERE excluded.last_seq>message_activity.last_seq;
  INSERT OR IGNORE INTO message_hide_events(conversation_id,seq,user_id,message_id)
  SELECT e.conversation_id,e.seq,e.hide_user,e.hide_message FROM (SELECT NEW.conversation_id AS conversation_id,NEW.seq AS seq,NEW.at AS at,CASE WHEN NEW.kind IN ('message.created','message.updated') AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.id') END AS message_id,CASE WHEN NEW.kind IN ('message.created','message.updated') AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.authorType') END AS author,CASE WHEN NEW.kind IN ('message.created','message.updated') AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.status') END AS status,CASE WHEN NEW.kind='message.deleted' AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.userId') END AS hide_user,CASE WHEN NEW.kind='message.deleted' AND json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.message.id') END AS hide_message) AS e WHERE e.hide_user IS NOT NULL AND e.hide_message IS NOT NULL;
  UPDATE conversation_activity SET through_seq=NEW.seq WHERE conversation_id=NEW.conversation_id;
END;
CREATE TABLE event_history_state(id INTEGER PRIMARY KEY CHECK(id=1), scanned_rowid INTEGER NOT NULL DEFAULT 0, ready INTEGER NOT NULL DEFAULT 0, rows INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE event_history(conversation_id TEXT NOT NULL,seq INTEGER NOT NULL,at INTEGER NOT NULL,bytes INTEGER NOT NULL,message_id TEXT,PRIMARY KEY(conversation_id,seq)) WITHOUT ROWID;
CREATE INDEX event_history_age ON event_history(at,conversation_id,seq);
CREATE TABLE event_history_floor(conversation_id TEXT PRIMARY KEY,seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE TRIGGER event_history_account_insert AFTER INSERT ON event_history BEGIN
 UPDATE event_history_state SET rows=rows+1,bytes=bytes+NEW.bytes WHERE id=1;
END;
CREATE TRIGGER event_history_account_delete AFTER DELETE ON event_history BEGIN
 UPDATE event_history_state SET rows=rows-1,bytes=bytes-OLD.bytes WHERE id=1;
END;
CREATE TRIGGER event_history_insert AFTER INSERT ON events WHEN NEW.kind='message.updated' BEGIN
 INSERT OR IGNORE INTO event_history VALUES(NEW.conversation_id,NEW.seq,NEW.at,length(CAST(NEW.payload_json AS BLOB)),CASE WHEN json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.id') END);
END;
CREATE TRIGGER event_history_update AFTER UPDATE ON events BEGIN
 DELETE FROM event_history WHERE conversation_id=OLD.conversation_id AND seq=OLD.seq;
 INSERT INTO event_history SELECT NEW.conversation_id,NEW.seq,NEW.at,length(CAST(NEW.payload_json AS BLOB)),CASE WHEN json_valid(NEW.payload_json) THEN json_extract(NEW.payload_json,'$.id') END WHERE NEW.kind='message.updated';
END;
CREATE TRIGGER event_history_delete AFTER DELETE ON events BEGIN
 DELETE FROM event_history WHERE conversation_id=OLD.conversation_id AND seq=OLD.seq;
END;
CREATE INDEX group_mail_inbox_retry ON group_mail_inbox(status, reply_forwarded, reply_next_at);
CREATE INDEX messages_pending_link_previews ON messages(created_at)
          WHERE author_type='user' AND status IN ('complete','error')
          AND preview_url IS NOT NULL AND preview_url!='' AND link_preview_json IS NULL;
CREATE INDEX deliveries_queue ON deliveries(bot_id,status,queue_position);
CREATE INDEX deliveries_queue_tail ON deliveries(bot_id,queue_position);
