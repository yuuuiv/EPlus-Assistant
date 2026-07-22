import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { applyTheme, getPreferredTheme, persistTheme, type ThemeMode } from "../theme.js";

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeMode>(() => getPreferredTheme());

  useEffect(() => { applyTheme(theme); }, [theme]);

  function toggle(): void {
    setTheme((current) => {
      const next: ThemeMode = current === "dark" ? "light" : "dark";
      persistTheme(next);
      return next;
    });
  }

  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      onClick={toggle}
      title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
      aria-label="切换浅色/深色模式"
      aria-pressed={theme === "light"}
    >
      <span className="theme-toggle-icon" aria-hidden="true">
        <Sun size={16} className="theme-icon-sun" />
        <Moon size={16} className="theme-icon-moon" />
      </span>
      <span>{theme === "dark" ? "浅色模式" : "深色模式"}</span>
    </button>
  );
}
