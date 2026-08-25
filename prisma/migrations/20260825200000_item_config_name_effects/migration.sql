-- Add a JSON-serialized render configuration to catalog items. NAME_EFFECT
-- entries use it to describe how the app should render the effect
-- (animation, intensity, speed, particles, colors) so the server remains
-- the single source of truth for the effects catalog.
ALTER TABLE "items" ADD COLUMN "config" TEXT NOT NULL DEFAULT '{}';
