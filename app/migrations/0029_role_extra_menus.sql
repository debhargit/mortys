-- 0029_role_extra_menus.sql  (D1 / SQLite)
--
-- Lets a role turn on the "optional" sidebar groups (🔧 Service Center,
-- 🚗 Cars & Vehicles) for its staff by default. Those groups are otherwise
-- off until each user ticks "Show the Service Centre & Vehicles menus" in
-- My Preferences (POS_PREFS.showExtraMenus). With this flag on, everyone
-- assigned the role gets them without touching preferences -- e.g. a
-- Service Advisor role.
ALTER TABLE roles ADD COLUMN show_extra_menus INTEGER NOT NULL DEFAULT 0;
