import { index, integer, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  code: text("code").primaryKey(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const signals = sqliteTable(
  "signals",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    roomCode: text("room_code").notNull(),
    senderId: text("sender_id").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("idx_signals_room_id").on(table.roomCode, table.id)],
);

export const chatGuests = sqliteTable("chat_guests", {
  id: text("id").primaryKey(),
  state: text("state").notNull().default("idle"),
  partner: text("partner"),
  room: text("room"),
  lastPartner: text("last_partner"),
  seen: integer("seen").notNull(),
  queued: integer("queued").notNull().default(0),
  rateStart: integer("rate_start").notNull().default(0),
  rateCount: integer("rate_count").notNull().default(0),
}, (t) => [index("idx_chat_queue").on(t.state, t.seen), index("idx_chat_partner").on(t.partner)]);

export const chatSignals = sqliteTable("chat_signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipient: text("recipient").notNull(),
  room: text("room").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  created: integer("created").notNull(),
}, (t) => [index("idx_chat_signals_recipient").on(t.recipient, t.id), index("idx_chat_signals_created").on(t.created)]);

export const chatBlocks = sqliteTable("chat_blocks", {
  owner: text("owner").notNull(),
  target: text("target").notNull(),
  created: integer("created").notNull(),
}, (t) => [primaryKey({ columns: [t.owner, t.target] })]);

export const chatReports = sqliteTable("chat_reports", {
  id: text("id").primaryKey(),
  reporter: text("reporter").notNull(),
  target: text("target").notNull(),
  room: text("room").notNull(),
  reason: text("reason").notNull(),
  created: integer("created").notNull(),
  status: text("status").notNull().default("pending"),
});
