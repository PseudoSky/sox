import { type Tree, readJson } from '@nx/devkit';

export interface WorkspaceConfig {
  scope: string;
  groups: Record<string, { description: string }>;
  kinds: Record<string, { class: string; description: string }>;
  platforms: Record<string, { description: string }>;
  layers: Record<string, { description: string }>;
  defaults: {
    types?: { access?: string; publish?: boolean; nxLayer?: string; platform?: string };
    entrypoint?: { nxLayer?: string; platform?: string; access?: string; publish?: boolean };
    library?: { access?: string; publish?: boolean };
  };
}

const CONFIG_PATH = '.adhd/workspace.json';

export function readWorkspaceConfig(tree?: Tree): WorkspaceConfig | null {
  try {
    if (tree) {
      if (tree.exists(CONFIG_PATH)) {
        return readJson<WorkspaceConfig>(tree, CONFIG_PATH);
      }
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      if (fs.existsSync(CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      }
    }
  } catch {
    // Config is optional — fall through
  }
  return null;
}

export function validateGroup(group: string, config?: WorkspaceConfig | null): string | null {
  if (!config) return null; // No config means no validation
  if (config.groups[group]) return null; // Valid
  const known = Object.keys(config.groups).join(', ');
  return `Unknown group "${group}". Known groups: ${known}. Add it to .adhd/workspace.json if it's a new group.`;
}

export function validatePlatform(platform: string, config?: WorkspaceConfig | null): string | null {
  if (!config) return null;
  if (config.platforms[platform]) return null;
  const known = Object.keys(config.platforms).join(', ');
  return `Unknown platform "${platform}". Known platforms: ${known}.`;
}

export function validateNxLayer(layer: string, config?: WorkspaceConfig | null): string | null {
  if (!config) return null;
  if (config.layers[layer]) return null;
  const known = Object.keys(config.layers).join(', ');
  return `Unknown nxLayer "${layer}". Known layers: ${known}.`;
}
