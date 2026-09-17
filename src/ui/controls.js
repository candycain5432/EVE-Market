// Small form-control builders shared by the views.

import { h } from '../util/dom.js';

export function field(label, control, hint) {
  return h('label.field', {}, h('label', {}, label), control, hint ? h('span.hint', {}, hint) : null);
}

export function numberField(label, value, onInput, { step = 'any', min = null, max = null, hint = null, width = null } = {}) {
  const input = h('input', {
    type: 'number', value, step,
    min: min == null ? null : min,
    max: max == null ? null : max,
    style: width ? { width } : null,
    oninput: (ev) => onInput(ev.target.value === '' ? null : Number(ev.target.value)),
  });
  return field(label, input, hint);
}

export function selectField(label, value, options, onChange, hint) {
  const select = h('select', {
    onchange: (ev) => onChange(ev.target.value),
  }, options.map((o) => h('option', {
    value: o.value,
    selected: String(o.value) === String(value),
  }, o.label)));
  return field(label, select, hint);
}

export function checkField(label, checked, onChange) {
  return h('label.check', {}, h('input', {
    type: 'checkbox', checked,
    onchange: (ev) => onChange(ev.target.checked),
  }), label);
}

/** Segmented single-choice control. */
export function segment(value, options, onChange) {
  const wrap = h('div.seg');
  options.forEach((o) => {
    wrap.append(h(`button${String(o.value) === String(value) ? '.on' : ''}`, {
      type: 'button',
      onclick: () => onChange(o.value),
    }, o.label));
  });
  return wrap;
}

export function stat(key, value, sub) {
  return h('div.stat', {}, h('div.k', {}, key), h('div.v', {}, value), sub ? h('div.s', {}, sub) : null);
}

export function panel(title, actions, ...body) {
  return h('section.panel', {},
    title ? h('div.panel-head', {}, h('h2', {}, title), actions || null) : null,
    h('div.panel-body', {}, ...body));
}

export function flushPanel(title, actions, ...body) {
  return h('section.panel', {},
    title ? h('div.panel-head', {}, h('h2', {}, title), actions || null) : null,
    h('div.panel-body.flush', {}, ...body));
}
