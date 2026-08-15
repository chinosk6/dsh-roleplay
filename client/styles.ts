/** Component CSS, injected once as a tagged <style> element.
 *
 * Token notes (dsh design-platform.css):
 *  - --dsw-alias-bg-base / bg-layer-1..3 are all PAGE white in the light
 *    theme, so component surfaces use --dsw-alias-bg-module-platform (a
 *    light gray on light theme, dark gray on dark theme) for contrast.
 *  - There is NO --dsw-alias-border-light token; visible borders come from
 *    --dsw-alias-border-l2 (rgba(0,0,0,.1) light / rgba(255,255,255,.12) dark).
 *  - --dsw-alias-interactive-bg-hover is translucent, so hover fills use
 *    --dsw-alias-interactive-bg-hover-solid where stacking matters.
 */

export const CSS_TAG = 'dsh-roleplay/client'

export const CSS = `
.rp-dock{display:flex;flex-direction:column;gap:8px;padding:8px 12px;border-radius:14px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);font-size:13px;color:var(--dsw-alias-label-primary);box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px)*2);max-width:var(--dsh-composer-card-max-width,780px);margin:0 auto;flex:none}
.rp-dock-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rp-avatar{width:34px;height:34px;border-radius:50%;object-fit:cover;flex:none;background:var(--dsw-alias-bg-layer-2)}
.rp-avatar-fallback{width:34px;height:34px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover-solid);font-weight:600}
.rp-name{font-weight:600;font-size:14px}
.rp-muted{color:var(--dsw-alias-label-secondary)}
.rp-spacer{flex:1}
.rp-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-radius:10px;padding:4px 10px;font-size:12px;line-height:18px;font-family:inherit}
.rp-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rp-btn.rp-on{border-color:var(--dsw-alias-state-business-primary, #4d6bfe);color:var(--dsw-alias-state-business-primary, #4d6bfe)}
.rp-btn:disabled{opacity:.5;cursor:default}
.rp-cardgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;max-height:280px;overflow-y:auto;padding:2px}
.rp-cardcell{cursor:pointer;display:flex;gap:8px;align-items:center;padding:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);text-align:left;font-family:inherit;color:var(--dsw-alias-label-primary);position:relative;overflow:hidden}
.rp-cardcell:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.rp-cardcell .rp-cardname,.rp-cardcell .rp-cardnote{display:block;position:relative;z-index:1}
.rp-cardcell .rp-cardname{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-cardcell .rp-cardnote{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rp-greeting{max-height:120px;overflow-y:auto;white-space:pre-wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);border-left:3px solid var(--dsw-alias-border-l2);padding:2px 0 2px 10px}
.rp-popover{position:relative}
.rp-popover-panel{position:absolute;bottom:calc(100% + 6px);left:0;z-index:30;width:320px;padding:10px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv2, 0 4px 16px rgba(0,0,0,.2));display:flex;flex-direction:column;gap:8px}
.rp-textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);padding:6px 8px;font-family:inherit;font-size:12px}
.rp-imggrid{display:flex;flex-wrap:wrap;gap:8px;padding:4px 0}
.rp-imggrid img{max-width:280px;max-height:340px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);cursor:zoom-in}
.rp-toolcard{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2)}
.rp-toolcard-title{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rp-savedcard{display:flex;gap:10px;align-items:center}
.rp-savedcard img{width:56px;height:56px;border-radius:12px;object-fit:cover}
.rp-settings{display:flex;flex-direction:column;gap:20px;font-size:13px;color:var(--dsw-alias-label-primary);padding-top:6px}
.rp-settings h3{margin:0 0 2px;font-size:15px}
.rp-settings h4{margin:12px 0 2px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.rp-field{display:flex;flex-direction:column;gap:4px;margin:6px 0}
.rp-field label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rp-field input,.rp-field select,.rp-field textarea{box-sizing:border-box;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);padding:6px 8px;font-family:inherit;font-size:13px}
.rp-field textarea{min-height:60px;resize:vertical}
.rp-inline{display:flex;gap:12px;flex-wrap:wrap}
.rp-inline .rp-field{flex:1;min-width:140px}
.rp-cardrow{display:flex;align-items:center;gap:10px;padding:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}
.rp-cardrow + .rp-cardrow{margin-top:8px}
.rp-cardrow .rp-grow{flex:1;min-width:0}
.rp-cardrow .rp-tags{font-size:11px;color:var(--dsw-alias-label-secondary)}
.rp-actions{display:flex;gap:6px;flex-wrap:wrap}
.rp-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.rp-error{font-size:12px;color:var(--dsw-alias-state-error-primary, #e5484d)}
.rp-editor-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rp-editor-title{font-size:15px;font-weight:600}
.rp-editor-avatar-row{display:flex;align-items:center;gap:12px;margin:6px 0 10px}
.rp-editor-avatar{width:64px;height:64px;border-radius:14px;object-fit:cover;border:1px solid var(--dsw-alias-border-l2)}
.rp-loreentry{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:8px 10px;margin:8px 0;background:var(--dsw-alias-bg-module-platform)}
.rp-loreentry-head{display:flex;align-items:center;margin-bottom:4px}
.rp-btn-primary{border-color:var(--dsw-alias-state-business-primary, #4d6bfe);color:var(--dsw-alias-state-business-primary, #4d6bfe);font-weight:600}
.rp-btn-primary:hover{background:var(--dsw-alias-state-business-primary, #4d6bfe);color:#fff}
.rp-btn-danger{color:var(--dsw-alias-state-error-primary, #e5484d)}
.rp-btn-danger:hover{border-color:var(--dsw-alias-state-error-primary, #e5484d);background:rgba(229,72,77,.1)}
.rp-forge-result{max-width:720px}
.rp-toolcard-head{display:flex;flex-direction:column;gap:2px;margin-bottom:4px}

/* Role-play bubble layout. Scoped by the dock-managed body[data-rp-active]
   flag, so it can only apply while a role-play session is current. It styles
   the assistant flow item's box only (background/border/width) via the public
   data-chat-flow-kind attribute — the NATIVE renderers inside (markdown,
   Think rows, tool cards) keep their own typography and colors untouched. */
body[data-rp-active="1"] [data-chat-flow-kind="assistant-step"]{width:fit-content;min-width:220px;max-width:min(620px,90%);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:4px 16px 16px 16px;padding:10px 14px;box-sizing:border-box}

/* Interleaved illustrations. generate_image flow nodes (marked .rp-genimg)
   shed their card chrome and tuck between the surrounding story bubbles, so
   paragraph/image/paragraph reads as ONE continuous message: negative margins
   cancel most of the flow column's 16px gap (net 6px), and the step that
   continues after an image loses its "new message" corner tail. Other tool
   nodes (e.g. ask_user_question) keep the stock spacing. */
body[data-rp-active="1"] [data-chat-flow-kind="tool-call"]:has(.rp-genimg){margin-top:-10px}
body[data-rp-active="1"] [data-chat-flow-kind="tool-call"]:has(.rp-genimg) + [data-chat-flow-kind="assistant-step"]{margin-top:-10px;border-radius:16px}
body[data-rp-active="1"] .rp-genimg{background:transparent;border:none;border-radius:0;padding:2px 0}
body[data-rp-active="1"] .rp-genimg-images > .rp-toolcard-title{display:none}
body[data-rp-active="1"] .rp-genimg .rp-imggrid{padding:0}

/* Pending / failed image slots (background generation still running). */
.rp-imgtile{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:220px;min-height:140px;padding:12px;box-sizing:border-box;border-radius:12px;border:1px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.rp-imgfail{border-style:solid;max-width:300px;overflow:auto;color:var(--dsw-alias-state-error-primary, #e5484d)}
.rp-imgspin{flex:none;width:14px;height:14px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:rp-imgspin .9s linear infinite}
@keyframes rp-imgspin{to{transform:rotate(360deg)}}

/* Opening message: the card's first message rendered as the character's
   first bubble, prepended to the flow column via the [data-rp-opening]
   holder (blank sessions preview it inside the dock as .rp-greeting). */
[data-rp-opening]{display:flex;width:100%}
.rp-opening{width:fit-content;min-width:220px;max-width:min(620px,90%);background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:4px 16px 16px 16px;padding:10px 14px;box-sizing:border-box}
.rp-opening-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.rp-opening-head .rp-avatar,.rp-opening-head .rp-avatar-fallback{width:24px;height:24px;font-size:12px}
.rp-opening-name{font-size:13px;font-weight:600}
.rp-opening-tag{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 5px}
.rp-opening-body{font-size:15px;line-height:26px;white-space:pre-wrap;overflow-wrap:anywhere}

/* Prose coloring — spans for plugin-owned DOM, ::highlight() for native
   assistant messages (ranges only exist while a role-play session is open).
   Kept as separate rules: an unsupported ::highlight selector must not
   invalidate the plain-class one. */
.rp-say{color:var(--dsw-alias-state-business-primary, #4d6bfe)}
.rp-think{color:var(--dsw-alias-label-tertiary, #9b9fa6)}
::highlight(rp-say){color:var(--dsw-alias-state-business-primary, #4d6bfe)}
::highlight(rp-think){color:var(--dsw-alias-label-tertiary, #9b9fa6)}

/* Message action row + buttons, matching the native IconActions metrics
   (28px round icon buttons, tertiary label color, 10px gap). */
.rp-msg-actions{display:flex;align-items:center;gap:10px;height:28px;margin-left:-6px}
.rp-msg-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:none;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.rp-msg-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rp-msg-action:disabled{opacity:.4;cursor:default}

/* Role-play user bubble replica, matching the native user row metrics
   (column/flex-end, 525px stack cap, 22px-radius bubble, 16px/24px text). */
.rp-user-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.rp-user-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%)}
.rp-user-bubble{background:var(--dsw-specific-bubble);max-width:100%;color:var(--dsw-alias-label-primary);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px;overflow-wrap:anywhere}
.rp-user-row .rp-msg-actions{margin-left:0;margin-right:-6px}
.rp-user-edit{font-size:16px;line-height:24px;min-height:96px}
.rp-user-instruction{margin-top:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l2);font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:pre-wrap}

/* Compact character bar shown while a question card owns the composer. */
[data-rp-question-dock]{margin-bottom:8px}

/* Compact inline select, matching the .rp-btn metrics. */
.rp-select{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-radius:10px;padding:4px 6px;font-size:12px;line-height:18px;font-family:inherit}
.rp-select:hover{background:var(--dsw-alias-interactive-bg-hover)}

/* Reference-image chooser rows + preview thumbnail. */
.rp-ref-row{display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px;cursor:pointer;color:var(--dsw-alias-label-primary)}
.rp-ref-row input{accent-color:var(--dsw-alias-state-business-primary, #4d6bfe)}
.rp-ref-preview{width:44px;height:44px;border-radius:8px;object-fit:cover;border:1px solid var(--dsw-alias-border-l2)}
/* API-key row with an inline points balance + refresh. */
.rp-keyrow{display:flex;align-items:center;gap:8px}
.rp-keyrow input{flex:1;min-width:0}
.rp-points{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}

/* Thumbnail trigger in the dock: same height budget as .rp-btn, image-only. */
.rp-ref-thumb{padding:2px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center}
.rp-ref-thumb img{width:22px;height:22px;border-radius:6px;object-fit:cover;display:block}
.rp-ref-thumb-empty{font-size:14px;line-height:1;color:var(--dsw-alias-label-tertiary)}

/* Image gallery. */
.rp-usage{display:flex;flex-direction:column;gap:6px}
.rp-usage-labels{display:flex;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rp-usage-track{height:6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover-solid);overflow:hidden}
.rp-usage-fill{height:100%;border-radius:6px;background:var(--dsw-alias-state-business-primary, #4d6bfe)}
.rp-tilegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:10px;margin-top:8px}
.rp-tile{position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}
.rp-tile img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover;cursor:pointer}
.rp-tile-selected{outline:2px solid var(--dsw-alias-state-business-primary, #4d6bfe);outline-offset:-2px}
.rp-tile-star{position:absolute;top:6px;right:6px;width:26px;height:26px;border-radius:26px;border:none;cursor:pointer;background:rgba(0,0,0,.45);color:#fff;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center}
.rp-tile-star.rp-on{color:#ffd166}
.rp-tile-check{position:absolute;top:6px;left:6px;width:22px;height:22px;border-radius:22px;background:rgba(0,0,0,.45);color:#fff;font-size:12px;display:none;align-items:center;justify-content:center;pointer-events:none}
.rp-tile-check.rp-on{display:inline-flex;background:var(--dsw-alias-state-business-primary, #4d6bfe)}
.rp-tile-size{position:absolute;bottom:4px;right:6px;font-size:10px;color:#fff;text-shadow:0 0 4px rgba(0,0,0,.8);pointer-events:none}
`

export function injectCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin-css', CSS_TAG)
  tag.textContent = CSS
  document.head.appendChild(tag)
}
