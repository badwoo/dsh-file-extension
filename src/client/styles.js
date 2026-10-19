/**
 * Plugin-owned stylesheet.
 *
 * Every colour comes from a `--dsw-alias-*` theme token so light and dark
 * themes are inherited rather than reimplemented. Literal colours appear only
 * for the destructive warning tint, which needs a red the token set does not
 * expose at the required saturation.
 *
 * Class names carry the `dfx-` prefix so nothing collides with host or other
 * plugins' rules.
 *
 * @module dsh-file-extension/client/styles
 */

export const CSS = `
.dfx-root {
  --dfx-radius: var(--dsw-radius-md, 8px);
  --dfx-radius-sm: var(--dsw-radius-sm, 6px);
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2147483000;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: 1.5;
}

.dfx-menu {
  position: fixed;
  min-width: 208px;
  max-width: 320px;
  padding: 4px;
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dfx-radius);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.1);
  pointer-events: auto;
  outline: none;
}

.dfx-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  border-radius: var(--dfx-radius-sm);
  cursor: pointer;
  white-space: nowrap;
}

.dfx-menu-item[data-active='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dfx-menu-item[aria-disabled='true'] {
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  cursor: default;
  opacity: 0.6;
}

.dfx-menu-item[aria-disabled='true'][data-active='true'] {
  background: none;
}

.dfx-menu-item[data-danger='true'] {
  color: var(--dsw-alias-state-error-primary);
}

.dfx-menu-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--dsw-alias-label-secondary);
}

.dfx-menu-item[data-danger='true'] .dfx-menu-icon {
  color: var(--dsw-alias-state-error-primary);
}

.dfx-menu-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dfx-menu-shortcut {
  flex: none;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
  font-size: 11px;
}

.dfx-menu-separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--dsw-alias-border-l1);
}

.dfx-dialog-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: rgba(0, 0, 0, 0.32);
  pointer-events: auto;
}

.dfx-dialog {
  width: 100%;
  max-width: 420px;
  box-sizing: border-box;
  padding: 18px 20px 16px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 12px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
}

.dfx-dialog-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.dfx-dialog-body {
  margin: 0 0 16px;
  color: var(--dsw-alias-label-secondary);
  word-break: break-word;
}

.dfx-dialog-body[data-danger='true'] {
  color: var(--dsw-alias-state-error-primary);
  font-weight: 500;
}

.dfx-dialog-path {
  display: block;
  margin-top: 6px;
  padding: 6px 8px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  border-radius: var(--dfx-radius-sm);
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 12px;
  word-break: break-all;
  max-height: 96px;
  overflow: auto;
}

.dfx-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.dfx-dialog-label {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

.dfx-input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 10px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dfx-radius-sm);
  outline: none;
}

.dfx-input:focus {
  border-color: var(--dsw-alias-brand-primary);
}

.dfx-input[data-invalid='true'] {
  border-color: var(--dsw-alias-state-error-primary);
}

.dfx-dialog-hint {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  min-height: 16px;
}

.dfx-dialog-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dfx-dialog-row .dfx-input {
  flex: 1;
}

.dfx-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

.dfx-button {
  padding: 6px 14px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dfx-radius-sm);
  cursor: pointer;
}

.dfx-button:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dfx-button[data-primary='true'] {
  color: #fff;
  background: var(--dsw-alias-brand-primary);
  border-color: transparent;
}

.dfx-button[data-danger='true'] {
  color: #fff;
  background: var(--dsw-alias-state-error-primary);
  border-color: transparent;
}

.dfx-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.dfx-toast-stack {
  position: fixed;
  left: 50%;
  bottom: 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  transform: translateX(-50%);
  pointer-events: none;
}

.dfx-toast {
  max-width: 460px;
  padding: 8px 14px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1));
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 10px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.2);
  pointer-events: auto;
  word-break: break-word;
}

.dfx-toast[data-level='error'] {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

.dfx-toast[data-level='success'] {
  border-color: var(--dsw-alias-state-success-primary);
}

.dfx-row-at {
  position: absolute;
  top: 50%;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-top: -11px;
  padding: 0;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1);
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dfx-radius-sm);
  cursor: pointer;
  opacity: 1;
  pointer-events: auto;
  z-index: 2;
}

.dfx-row-at:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}

/* The official row button fills the row; keep the file name clear of the hover
   button while it is shown so the two never overlap. */
[data-dfx-hover='true'] > button .k-1LKG_name,
[data-dfx-hover='true'] > button span {
  padding-right: 26px;
}

.dfx-rename-input {
  position: absolute;
  box-sizing: border-box;
  margin: 0;
  padding: 0 4px;
  font: inherit;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-brand-primary);
  border-radius: var(--dfx-radius-sm);
  outline: none;
  z-index: 3;
  /* The overlay root is click-through (pointer-events: none) so the floating
     layer never blocks the application; every element that must receive input
     has to opt back in. Without this the inline editor could not be clicked,
     the pointer landed on the page behind it, and the resulting blur made the
     rename look like it silently did nothing. */
  pointer-events: auto;
}

.dfx-hidden-probe {
  display: none;
}

/* Update dialog: the version rows read as a small definition list, with the two
   values aligned so "installed" and "available" can be compared at a glance. */
.dfx-dialog-wide {
  max-width: 480px;
}

.dfx-update-versions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.dfx-update-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.dfx-update-version {
  font-family: var(--dsw-font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}
`
