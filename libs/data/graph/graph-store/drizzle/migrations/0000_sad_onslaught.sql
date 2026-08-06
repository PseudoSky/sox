-- Baseline migration: graph-store node + edge tables
-- Matches the current GRAPH_DDL exactly, with all CHECK constraints and indexes.
-- Uses IF NOT EXISTS for idempotent application on pre-existing stores.
CREATE TABLE IF NOT EXISTS `node` (
	`rowid` integer PRIMARY KEY NOT NULL,
	`uid` text NOT NULL,
	`kind` text NOT NULL,
	`content` text,
	`name` text,
	`summary` text,
	`topic` text,
	`tags` text,
	`importance` real DEFAULT 1.0,
	`confidence` real,
	`content_hash` text,
	`namespace` text DEFAULT 'global',
	`meta` text,
	`agent_id` text,
	`session_id` text,
	`source` text CHECK (`source` IN ('message','tool_output','observation','document','reflection','import')),
	`project_path` text,
	`level` integer,
	`resume_state` text,
	`t_occurred` text,
	`t_expires` text,
	`t_created` text NOT NULL,
	`t_valid` text,
	`t_invalid` text,
	`is_superseded` integer DEFAULT 0,
	`access_count` integer DEFAULT 0,
	`last_access` text,
	`t_updated` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `edge` (
	`rowid` integer PRIMARY KEY NOT NULL,
	`src` integer NOT NULL REFERENCES `node`(`rowid`) ON DELETE CASCADE,
	`dst` integer NOT NULL REFERENCES `node`(`rowid`) ON DELETE CASCADE,
	`rel` text NOT NULL CHECK (`rel` IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
	`weight` real DEFAULT 1.0,
	`confidence` real,
	`origin` text CHECK (`origin` IN ('extracted','inferred','user_asserted')),
	`meta` text,
	`t_created` text NOT NULL,
	`t_expired` text,
	`t_valid` text,
	`t_invalid` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `node_uid_unique` ON `node` (`uid`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_kind` ON `node` (`kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_hash` ON `node` (`content_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_agent` ON `node` (`agent_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_session` ON `node` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_validity` ON `node` (`t_invalid`) WHERE `t_invalid` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_importance` ON `node` (`importance`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_temporal` ON `node` (`t_invalid`, `t_created` DESC) WHERE `t_invalid` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_topic` ON `node` (`topic`) WHERE `topic` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_project` ON `node` (`project_path`) WHERE `project_path` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_namespace` ON `node` (`namespace`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_node_expires` ON `node` (`t_expires`) WHERE `t_expires` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_edge_src` ON `edge` (`src`, `rel`) WHERE `t_expired` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_edge_dst` ON `edge` (`dst`, `rel`) WHERE `t_expired` IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ix_edge_live` ON `edge` (`t_invalid`) WHERE `t_invalid` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `ix_edge_unique` ON `edge` (`src`, `dst`, `rel`);
