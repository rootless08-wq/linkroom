CREATE TABLE `chat_blocks` (
	`owner` text NOT NULL,
	`target` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`owner`, `target`)
);
--> statement-breakpoint
CREATE TABLE `chat_guests` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'idle' NOT NULL,
	`partner` text,
	`room` text,
	`last_partner` text,
	`seen` integer NOT NULL,
	`queued` integer DEFAULT 0 NOT NULL,
	`rate_start` integer DEFAULT 0 NOT NULL,
	`rate_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chat_queue` ON `chat_guests` (`state`,`seen`);--> statement-breakpoint
CREATE INDEX `idx_chat_partner` ON `chat_guests` (`partner`);--> statement-breakpoint
CREATE TABLE `chat_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter` text NOT NULL,
	`target` text NOT NULL,
	`room` text NOT NULL,
	`reason` text NOT NULL,
	`created` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `chat_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipient` text NOT NULL,
	`room` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_chat_signals_recipient` ON `chat_signals` (`recipient`,`id`);--> statement-breakpoint
CREATE INDEX `idx_chat_signals_created` ON `chat_signals` (`created`);