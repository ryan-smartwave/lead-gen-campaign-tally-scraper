import { hashtagUrl } from "../config/index.js";

export function planNext({ index, targets, caps, downgraded, window = null, fbLocationId = null }) {
  const canPreload = !!caps?.tabs && !downgraded && index < targets.length - 1;
  const next = canPreload ? targets[index + 1] : null;
  return {
    preload: canPreload,
    url: next ? hashtagUrl({ platform: next.platform, value: next.value }, window, fbLocationId) : null,
  };
}
