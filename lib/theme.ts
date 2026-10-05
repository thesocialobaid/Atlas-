// A cookie rather than localStorage so the server can write the choice onto
// <html> in the first response: no flash of the wrong palette on reload.
// No cookie means follow the system.
export const THEME_COOKIE = "theme";

export type Theme = "system" | "light" | "dark";

export function parseTheme(value: string | undefined): Theme {
  return value === "light" || value === "dark" ? value : "system";
}
