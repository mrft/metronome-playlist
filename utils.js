/**
 * Metronome Playlist — utils.js
 *
 * Utility for wrapping Preact functional components as Custom Elements
 * without requiring a build step.
 */

import { render } from 'preact';
import { html }   from 'htm/preact';

/**
 * Creates (and optionally registers) a Custom Element class that renders
 * the given Preact component into itself.
 *
 * The tag name is auto-derived from the component's function name
 * (PascalCase → x-kebab-case) unless overridden via `options.tag`.
 *
 * Options:
 *   tag    {string}   Custom element tag name. Auto-derived when omitted.
 *   define {boolean}  When `false`, skips `customElements.define()`.
 *                     Useful when you intend to subclass before registering.
 *                     Defaults to `true`.
 *
 * The returned class exposes:
 *   setProp(name, value)  Update a single prop and trigger a re-render.
 *   _props                Plain object holding the current props (writable).
 *   _render()             Force a synchronous re-render.
 *
 * @param {Function} Component  Preact functional component to wrap.
 * @param {{ tag?: string, define?: boolean }} [options]
 * @returns {typeof HTMLElement}
 */
export function preactComponent(Component, options = {}) {
  const tag = options.tag ?? autoTagName(Component.name);

  class PreactElement extends HTMLElement {
    constructor() {
      super();
      this._props = {};
    }

    connectedCallback() {
      this._render();
    }

    disconnectedCallback() {
      render(null, this);
    }

    /** Update a single prop and re-render (no-op while disconnected). */
    setProp(name, value) {
      this._props[name] = value;
      if (this.isConnected) this._render();
    }

    _render() {
      render(html`<${Component} ...${this._props} />`, this);
    }
  }

  if (options.define !== false) {
    customElements.define(tag, PreactElement);
  }

  return PreactElement;
}

/**
 * Converts a PascalCase component name to an `x-kebab-case` tag name.
 * @param {string} name
 * @returns {string}
 */
function autoTagName(name) {
  return (
    'x-' +
    name
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .toLowerCase()
  );
}
