// English dictionary: Vietnamese source text -> English. One file per area; keys must be unique across files
// (checked by test/unit/i18n.test.js).
import { admin } from './admin.js';
import { common } from './common.js';
import { messages } from './messages.js';
import { ui } from './ui.js';

export const PARTS = { common, admin, messages, ui };
export const EN = Object.assign({}, ...Object.values(PARTS));
