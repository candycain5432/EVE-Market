// Sortable, scrollable data table.
//
// columns: [{ key, label, align, title, sortable, value(row), render(row), cls(row) }]
//   value(row) -> sortable primitive (defaults to row[key])
//   render(row) -> string | Node   (defaults to value)

import { h, mount } from '../util/dom.js';

export class DataTable {
  constructor(container, { columns, onRowClick = null, sortKey = null, sortDir = 'desc', empty = 'Nothing to show.', limit = 500 }) {
    this.container = container;
    this.columns = columns;
    this.onRowClick = onRowClick;
    this.sortKey = sortKey || columns[0].key;
    this.sortDir = sortDir;
    this.empty = empty;
    this.limit = limit;
    this.rows = [];
  }

  setRows(rows) {
    this.rows = rows || [];
    this.render();
    return this;
  }

  setLimit(limit) {
    this.limit = limit;
    this.render();
  }

  sorted() {
    const col = this.columns.find((c) => c.key === this.sortKey) || this.columns[0];
    const val = (row) => (col.value ? col.value(row) : row[col.key]);
    const dir = this.sortDir === 'asc' ? 1 : -1;
    return [...this.rows].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;      // nulls always sink
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (av - bv) * dir;
    });
  }

  toggleSort(key) {
    if (this.sortKey === key) this.sortDir = this.sortDir === 'desc' ? 'asc' : 'desc';
    else { this.sortKey = key; this.sortDir = 'desc'; }
    this.render();
  }

  render() {
    if (!this.rows.length) {
      mount(this.container, h('div.empty', {}, this.empty));
      return;
    }

    const head = h('tr', {}, this.columns.map((col) => h(
      `th${col.sortable === false ? '.nosort' : ''}`,
      {
        title: col.title || col.label,
        style: col.align ? { textAlign: col.align } : null,
        onclick: col.sortable === false ? null : () => this.toggleSort(col.key),
      },
      col.label,
      this.sortKey === col.key ? h('span.arrow', {}, this.sortDir === 'desc' ? '▼' : '▲') : null,
    )));

    const rows = this.sorted().slice(0, this.limit).map((row) => {
      const tr = h(`tr${this.onRowClick ? '.clickable' : ''}`, {}, this.columns.map((col) => {
        const content = col.render ? col.render(row) : (col.value ? col.value(row) : row[col.key]);
        const cls = [col.numeric === false ? '' : 'num', col.cls ? col.cls(row) : ''].filter(Boolean).join('.');
        return h(`td${cls ? `.${cls}` : ''}`, { style: col.align ? { textAlign: col.align } : null }, content);
      }));
      if (this.onRowClick) tr.addEventListener('click', (ev) => {
        if (ev.target.closest('button, a, input')) return;   // let controls handle themselves
        this.onRowClick(row, ev);
      });
      return tr;
    });

    const total = this.rows.length;
    mount(
      this.container,
      h('div.table-wrap', {}, h('table.data', {}, h('thead', {}, head), h('tbody', {}, rows))),
      total > this.limit
        ? h('div.empty', {}, `Showing top ${this.limit} of ${total.toLocaleString()} rows.`)
        : null,
    );
  }
}
