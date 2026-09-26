CREATE TABLE `private_rooms` (
  `code` text PRIMARY KEY NOT NULL,
  `invite_hash` text NOT NULL,
  `invite_expires_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `host_id` text NOT NULL,
  `host_hash` text NOT NULL,
  `guest_id` text,
  `guest_hash` text,
  `generation` integer DEFAULT 0 NOT NULL,
  `closed` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_private_rooms_expiry` ON `private_rooms` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `private_signals` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `room_code` text NOT NULL,
  `recipient_id` text NOT NULL,
  `sender_id` text NOT NULL,
  `generation` integer NOT NULL,
  `kind` text NOT NULL,
  `payload` text NOT NULL,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_private_signals_recipient` ON `private_signals` (`room_code`,`recipient_id`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_private_signals_created` ON `private_signals` (`created_at`);
--> statement-breakpoint
CREATE TABLE `private_rate_limits` (
  `bucket` text PRIMARY KEY NOT NULL,
  `count` integer NOT NULL,
  `expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_private_rate_expiry` ON `private_rate_limits` (`expires_at`);
