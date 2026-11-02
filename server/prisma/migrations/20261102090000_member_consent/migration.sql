-- Require consent unless an instance admin explicitly enables direct additions.
ALTER TABLE "instance_settings" ADD COLUMN "allow_direct_member_add" BOOLEAN NOT NULL DEFAULT false;
