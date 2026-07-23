import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";

export type SortDirection = "asc" | "desc";

export type ColumnFilter<T> =
  | { readonly type: "text"; readonly value: (row: T) => string }
  | { readonly type: "select"; readonly value: (row: T) => string }
  | { readonly type: "min"; readonly value: (row: T) => number; readonly placeholder?: string };

export interface Column<T> {
  readonly key: string;
  readonly label: string;
  readonly render: (row: T) => React.ReactNode;
  /** Omit to make the column unsortable. */
  readonly sortValue?: (row: T) => string | number;
  readonly filter?: ColumnFilter<T>;
  /** Keeps this column's cells on one line - for short categorical values (status, gender)
   *  where a mid-word wrap reads as broken, unlike free-text columns (tour title) that should wrap. */
  readonly noWrap?: boolean;
  readonly align?: "left" | "right";
}

interface SortableFilterableTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly emptyMessage?: string;
}

export function SortableFilterableTable<T>(props: SortableFilterableTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; direction: SortDirection } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});

  function toggleSort(column: Column<T>): void {
    if (!column.sortValue) return;
    setSort((current) => {
      if (!current || current.key !== column.key) return { key: column.key, direction: "asc" };
      if (current.direction === "asc") return { key: column.key, direction: "desc" };
      return null;
    });
  }

  const selectOptions = useMemo(() => {
    const options: Record<string, string[]> = {};
    for (const column of props.columns) {
      if (column.filter?.type === "select") {
        const getValue = column.filter.value;
        options[column.key] = Array.from(new Set(props.rows.map((row) => getValue(row)))).sort((a, b) => a.localeCompare(b, "zh"));
      }
    }
    return options;
  }, [props.columns, props.rows]);

  const filteredRows = useMemo(() => props.rows.filter((row) =>
    props.columns.every((column) => {
      const raw = filters[column.key];
      if (!raw || !column.filter) return true;
      if (column.filter.type === "text") return column.filter.value(row).toLowerCase().includes(raw.toLowerCase());
      if (column.filter.type === "select") return column.filter.value(row) === raw;
      const min = Number(raw);
      return Number.isNaN(min) || column.filter.value(row) >= min;
    })
  ), [props.rows, props.columns, filters]);

  const sortedRows = useMemo(() => {
    if (!sort) return filteredRows;
    const column = props.columns.find((candidate) => candidate.key === sort.key);
    if (!column?.sortValue) return filteredRows;
    const getValue = column.sortValue;
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const left = getValue(a);
      const right = getValue(b);
      if (typeof left === "number" && typeof right === "number") return (left - right) * sign;
      return String(left).localeCompare(String(right), "zh") * sign;
    });
  }, [filteredRows, sort, props.columns]);

  return <div className="table-wrap">
    <table className="data-table">
      <thead>
        <tr>
          {props.columns.map((column) => <th key={column.key} className={column.noWrap ? "th-nowrap" : undefined} style={column.align === "right" ? { textAlign: "right" } : undefined}>
            <button type="button" className="th-sort" onClick={() => toggleSort(column)} disabled={!column.sortValue}>
              <span>{column.label}</span>
              {column.sortValue ? (
                sort?.key === column.key
                  ? (sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
                  : <ArrowUpDown size={12} className="th-sort-idle" />
              ) : null}
            </button>
            {column.filter ? <ColumnFilterControl column={column} filters={filters} setFilters={setFilters} options={selectOptions[column.key]} /> : null}
          </th>)}
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => <tr key={props.rowKey(row)}>
          {props.columns.map((column) => <td key={column.key} className={column.noWrap ? "td-nowrap" : undefined} style={column.align === "right" ? { textAlign: "right" } : undefined}>{column.render(row)}</td>)}
        </tr>)}
      </tbody>
    </table>
    {sortedRows.length === 0 ? <p className="empty-state">{props.emptyMessage ?? "没有符合筛选条件的记录。"}</p> : null}
  </div>;
}

function ColumnFilterControl<T>(props: {
  readonly column: Column<T>;
  readonly filters: Record<string, string>;
  readonly setFilters: Dispatch<SetStateAction<Record<string, string>>>;
  readonly options?: string[];
}) {
  const { column, filters, setFilters } = props;
  const value = filters[column.key] ?? "";

  function update(next: string): void {
    setFilters((current) => {
      const copy = { ...current };
      if (next) copy[column.key] = next;
      else delete copy[column.key];
      return copy;
    });
  }

  if (column.filter?.type === "select") {
    return <select className="th-filter" value={value} onChange={(event) => update(event.target.value)} aria-label={`按${column.label}筛选`}>
      <option value="">全部</option>
      {(props.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
    </select>;
  }
  if (column.filter?.type === "min") {
    return <input className="th-filter" type="number" placeholder={column.filter.placeholder ?? "≥"} value={value} onChange={(event) => update(event.target.value)} aria-label={`按${column.label}筛选`} />;
  }
  return <input className="th-filter" type="text" placeholder="筛选" value={value} onChange={(event) => update(event.target.value)} aria-label={`按${column.label}筛选`} />;
}
