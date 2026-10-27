import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  SETTING_SCHEMA,
  mergeLayers,
  parseSettingsJson,
  validateSetting,
  type SettingsLayer,
} from "../settingsSchema";
import type { TreeNode, UserPreferences } from "../types";

export const USER_SETTINGS_KEY = "veyra_user_settings";
export const PROJECT_SETTINGS_PATH = ".veyra/settings.json";

const hasProjectFile = (tree: TreeNode[]) =>
  !!tree.find((n) => n.type === "dir" && n.name === ".veyra")?.children?.some((n) => n.type === "file" && n.name === "settings.json");

function loadUserExtras(): SettingsLayer {
  try {
    return parseSettingsJson(localStorage.getItem(USER_SETTINGS_KEY) ?? "");
  } catch {
    return {};
  }
}

/**
 * M105: effective settings = server prefs < local user extras < project
 * `.veyra/settings.json`. Invalid project values are ignored (schema-checked).
 */
export function useLayeredSettings(
  projectId: string | undefined,
  tree: TreeNode[],
  preferences: UserPreferences,
  updateServerPrefs: (u: Partial<UserPreferences>) => Promise<void>,
) {
  const [userExtras, setUserExtras] = useState<SettingsLayer>(loadUserExtras);
  const [projectLayer, setProjectLayer] = useState<SettingsLayer>({});
  const present = hasProjectFile(tree);

  useEffect(() => {
    setProjectLayer({});
    if (!projectId || !present) return;
    let cancelled = false;
    api<{ content: string }>(`/api/projects/${projectId}/file?path=${encodeURIComponent(PROJECT_SETTINGS_PATH)}`)
      .then((r) => !cancelled && setProjectLayer(parseSettingsJson(r.content)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, present]);

  const userLayer = useMemo<SettingsLayer>(() => {
    const server: SettingsLayer = {};
    for (const d of SETTING_SCHEMA)
      if (d.server) server[d.key] = (preferences as unknown as Record<string, string | number | boolean>)[d.key]!;
    return { ...server, ...userExtras };
  }, [preferences, userExtras]);

  const effective = useMemo(() => mergeLayers(preferences, userExtras, projectLayer), [preferences, userExtras, projectLayer]);

  const setUser = useCallback(
    async (key: string, value: string | number | boolean) => {
      if (!validateSetting(key, value)) return;
      if (SETTING_SCHEMA.find((d) => d.key === key)?.server) {
        await updateServerPrefs({ [key]: value } as Partial<UserPreferences>);
        return;
      }
      setUserExtras((prev) => {
        const next = { ...prev, [key]: value };
        try {
          localStorage.setItem(USER_SETTINGS_KEY, JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
        return next;
      });
    },
    [updateServerPrefs],
  );

  /** value === undefined removes the project override. */
  const setProject = useCallback(
    async (key: string, value: string | number | boolean | undefined) => {
      if (!projectId || (value !== undefined && !validateSetting(key, value))) return;
      const next = { ...projectLayer };
      if (value === undefined) delete next[key];
      else next[key] = value;
      await api(`/api/projects/${projectId}/file`, {
        method: "POST",
        body: JSON.stringify({ path: PROJECT_SETTINGS_PATH, content: `${JSON.stringify(next, null, 2)}\n` }),
      });
      setProjectLayer(next);
    },
    [projectId, projectLayer],
  );

  return { effective, userLayer, projectLayer, setUser, setProject };
}
