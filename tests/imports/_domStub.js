/**
 * Minimal DOM stub for the import-panel UI tests.
 *
 * Intentionally small. Implements only the subset of the DOM the panel's
 * vanilla JS touches: IDs, textContent, hidden flag, addEventListener,
 * disabled, innerHTML (for clear-only assignments), file inputs, form
 * submit, button click, classList, children/appendChild.
 *
 * This avoids adding `jsdom` / `happy-dom` / `cheerio` as a test dependency
 * and keeps the repo's zero-devdep UI-testing story.
 *
 * Not a compliant DOM. Not suitable for production. Tests that need
 * fidelity beyond this should use jsdom (not installed here).
 */

/**
 * @param {string} html   HTML fragment to load into the stub's document
 * @returns a pseudo-browser with { window, document, runInlineScripts, fireEvent, flush }
 */
export const createDom = (html) => {
    const { root, scripts } = parseHtml(html);

    const document = {
        body: root,
        _byId: indexById(root),
        getElementById(id) { return this._byId[id] || null; },
        createElement(tag) { return makeElement(tag.toLowerCase(), this); }
    };

    const window = {
        document,
        // Testing code will populate fetch, confirm, location, FormData, File.
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        HTMLFormElement: null,       // not used by panel code
    };

    const eventLoop = {
        queue: [],
        flush: async () => {
            // Let microtasks settle (multiple times for chained promises).
            for (let i = 0; i < 6; i++) {
                await Promise.resolve();
                await new Promise(r => setImmediate ? setImmediate(r) : setTimeout(r, 0));
            }
        }
    };

    return {
        window,
        document,
        runInlineScripts() {
            for (const code of scripts) {
                runInContext(code, window, document);
            }
        },
        fireEvent: async (el, type) => {
            const handlers = (el._listeners && el._listeners[type]) || [];
            const event = {
                type,
                target: el,
                preventDefault() { this.defaultPrevented = true; },
                defaultPrevented: false
            };
            for (const h of handlers) {
                await h(event);
            }
        },
        flush: eventLoop.flush
    };
};

// ---------------------------------------------------------------------------
// HTML parsing (attribute-aware, tag-based, non-validating)
// ---------------------------------------------------------------------------
//
// Handles enough of our panel partial:
//   - named elements: section, h2, h3, div, p, span, form, input, button,
//     table, thead, tbody, tr, th, td, ul, li, details, summary, style,
//     script, label, select, option
//   - attributes: id, class, type, accept, name, required, hidden, aria-*,
//     role, for, min-width (in style attr; ignored)
//   - nested children
//   - <!-- comments -->  (stripped)
//   - <%= ... %> EJS output (expected to be resolved by ejs before parseHtml)
//   - <script> contents captured verbatim
//
// NOT handled: SVG, CDATA, HTML entities other than trivial ones. Fine for
// our fixture.

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

const parseHtml = (html) => {
    // Strip HTML comments.
    html = html.replace(/<!--[\s\S]*?-->/g, '');
    const root = makeElement('body', null);
    const scripts = [];
    const styles = [];

    let i = 0;
    const stack = [root];
    const top = () => stack[stack.length - 1];

    const textNode = (text) => {
        if (!text) return;
        // Collapse whitespace on pure-whitespace chunks, but keep inline text.
        const node = {
            nodeType: 3,
            textContent: decodeEntities(text),
            parentNode: top(),
            _isText: true
        };
        top()._children.push(node);
    };

    while (i < html.length) {
        if (html[i] !== '<') {
            const next = html.indexOf('<', i);
            const chunk = next === -1 ? html.slice(i) : html.slice(i, next);
            textNode(chunk);
            if (next === -1) break;
            i = next;
            continue;
        }
        // Tag
        if (html.startsWith('</', i)) {
            const end = html.indexOf('>', i);
            const close = html.slice(i + 2, end).trim().toLowerCase();
            // Pop until matching.
            while (stack.length > 1 && top()._tag !== close) stack.pop();
            if (stack.length > 1) stack.pop();
            i = end + 1;
            continue;
        }
        const end = html.indexOf('>', i);
        if (end === -1) break;
        const raw = html.slice(i + 1, end);
        const selfClose = raw.endsWith('/');
        const head = selfClose ? raw.slice(0, -1) : raw;
        const m = head.match(/^([a-zA-Z0-9]+)(\s[\s\S]*)?$/);
        if (!m) { i = end + 1; continue; }
        const tag = m[1].toLowerCase();
        const attrStr = (m[2] || '').trim();
        const el = makeElement(tag, null);
        parseAttrs(attrStr, el);
        el.parentNode = top();
        top()._children.push(el);

        if (tag === 'script') {
            // Capture content verbatim up to </script>.
            const close = html.indexOf('</script>', end + 1);
            if (close === -1) break;
            scripts.push(html.slice(end + 1, close));
            i = close + '</script>'.length;
            continue;
        }
        if (tag === 'style') {
            const close = html.indexOf('</style>', end + 1);
            if (close === -1) break;
            styles.push(html.slice(end + 1, close));
            i = close + '</style>'.length;
            continue;
        }

        if (!selfClose && !VOID_TAGS.has(tag)) {
            stack.push(el);
        }
        i = end + 1;
    }

    return { root, scripts };
};

const parseAttrs = (s, el) => {
    if (!s) return;
    const attrs = {};
    const re = /([a-zA-Z_:][a-zA-Z0-9_:\-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        const name = m[1];
        const value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : ''));
        attrs[name] = value;
    }
    el._attrs = attrs;
    if ('id' in attrs) el.id = attrs.id;
    if ('class' in attrs) {
        el.className = attrs.class;
        el.classList = makeClassList(attrs.class);
    }
    if ('type' in attrs) el.type = attrs.type;
    if ('value' in attrs) el.value = attrs.value;
    if ('disabled' in attrs) el.disabled = attrs.disabled !== 'false';
    if ('hidden' in attrs) el.hidden = true;
    if ('required' in attrs) el.required = true;
};

const makeClassList = (clsString) => {
    const set = new Set((clsString || '').split(/\s+/).filter(Boolean));
    return {
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
        toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c))
    };
};

const decodeEntities = (s) =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');

// ---------------------------------------------------------------------------
// Element factory
// ---------------------------------------------------------------------------

const makeElement = (tag, owner) => {
    const el = {
        _tag: tag,
        _owner: owner,
        _attrs: {},
        _listeners: {},
        _children: [],
        id: '',
        className: '',
        classList: makeClassList(''),
        hidden: false,
        disabled: false,
        value: '',
        files: null,

        get children() {
            return this._children.filter(c => !c._isText);
        },

        get parentNode() { return this._parent; },
        set parentNode(p) { this._parent = p; },

        get textContent() {
            // Compose from text children + element children's textContent.
            let s = '';
            for (const c of this._children) {
                if (c._isText) s += c.textContent;
                else s += c.textContent;
            }
            return s;
        },
        set textContent(v) {
            this._children = [{
                nodeType: 3,
                textContent: String(v),
                parentNode: this,
                _isText: true
            }];
        },

        get innerHTML() { return this._innerHTML || ''; },
        set innerHTML(v) {
            // Only clearing is used by the panel code. We support only "".
            if (v === '' || v == null) {
                this._children = [];
                this._innerHTML = '';
            } else {
                this._innerHTML = String(v);
                // Best-effort: parse as HTML fragment.
                const parsed = parseHtml(String(v));
                this._children = parsed.root._children.map(c => {
                    c.parentNode = this;
                    return c;
                });
            }
        },

        appendChild(child) {
            child.parentNode = this;
            this._children.push(child);
            if (child.id && this._owner && this._owner._byId) {
                this._owner._byId[child.id] = child;
            } else {
                // Re-index upward.
                let root = this;
                while (root && !root._byId && root.parentNode) root = root.parentNode;
            }
            return child;
        },

        setAttribute(name, value) { this._attrs[name] = String(value); },
        removeAttribute(name) { delete this._attrs[name]; },

        addEventListener(type, handler) {
            if (!this._listeners[type]) this._listeners[type] = [];
            this._listeners[type].push(handler);
        },

        removeEventListener(type, handler) {
            const list = this._listeners[type] || [];
            const i = list.indexOf(handler);
            if (i !== -1) list.splice(i, 1);
        },

        querySelector(sel) {
            // Support only simple "tag" and "tag.class" and "button".
            return querySelectorFirst(this, sel);
        }
    };
    return el;
};

const querySelectorFirst = (el, sel) => {
    const m = sel.match(/^([a-zA-Z0-9]+)(?:\.([a-zA-Z0-9_-]+))?$/);
    if (!m) return null;
    const tag = m[1].toLowerCase();
    const cls = m[2];
    const walk = (node) => {
        for (const c of node._children || []) {
            if (c._isText) continue;
            if (c._tag === tag && (!cls || (c.classList && c.classList.contains(cls)))) {
                return c;
            }
            const deeper = walk(c);
            if (deeper) return deeper;
        }
        return null;
    };
    return walk(el);
};

const indexById = (root) => {
    const out = Object.create(null);
    const walk = (node) => {
        if (!node || node._isText) return;
        if (node.id) out[node.id] = node;
        for (const c of node._children || []) walk(c);
    };
    walk(root);
    // Attach owner ref so future appendChild calls can index.
    return out;
};

// ---------------------------------------------------------------------------
// Script runner
// ---------------------------------------------------------------------------

import vm from 'node:vm';

const runInContext = (code, window, document) => {
    const sandbox = {
        window,
        document,
        fetch: (...args) => window.fetch(...args),
        FormData: window.FormData,
        File: window.File,
        setTimeout: window.setTimeout,
        clearTimeout: window.clearTimeout,
        console,
        Promise,
        URL: globalThis.URL,
        JSON,
        Object, Array, String, Number, Boolean, Math, Date, Error,
        encodeURIComponent: globalThis.encodeURIComponent,
        decodeURIComponent: globalThis.decodeURIComponent
    };
    // Allow the script to reach window.location / window.confirm etc.
    Object.defineProperty(sandbox, 'location', {
        get() { return window.location; }
    });
    sandbox.confirm = (msg) => window.confirm(msg);

    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { timeout: 2000 });
};
