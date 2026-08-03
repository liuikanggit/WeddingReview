import { useState } from "react";
import type { ChecklistItem } from "../types";

interface Props {
  library: ChecklistItem[];
  checkedItemIds: string[];
  note: string;
  onToggleItem: (id: string) => void;
  onAddItem: (text: string) => void;
  onRemoveItem: (id: string) => void;
  onNoteChange: (text: string) => void;
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 13l4 4L19 7" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </svg>
);

export default function ChecklistPanel({
  library,
  checkedItemIds,
  note,
  onToggleItem,
  onAddItem,
  onRemoveItem,
  onNoteChange,
}: Props) {
  const [newItemText, setNewItemText] = useState("");

  function submitNewItem() {
    onAddItem(newItemText);
    setNewItemText("");
  }

  return (
    <aside className="checklist-panel">
      <section className="panel-section">
        <div className="panel-heading">
          <h3>修图要求</h3>
          {checkedItemIds.length > 0 && (
            <span className="panel-badge">已选 {checkedItemIds.length}</span>
          )}
        </div>

        {library.length === 0 ? (
          <p className="empty-hint">
            还没有常用要求。先在下面添加一条，比如「磨皮」「瘦脸」——建好后每张照片勾选即可，不用重复输入。
          </p>
        ) : (
          <ul className="checklist-library">
            {library.map((item) => {
              const checked = checkedItemIds.includes(item.id);
              return (
                <li key={item.id} className={checked ? "checked" : ""}>
                  <label>
                    <input type="checkbox" checked={checked} onChange={() => onToggleItem(item.id)} />
                    <span className="check-mark">
                      <CheckIcon />
                    </span>
                    <span className="check-text">{item.text}</span>
                  </label>
                  <button
                    className="remove-btn"
                    onClick={() => onRemoveItem(item.id)}
                    title="从常用要求中删除"
                  >
                    <TrashIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <form
          className="add-item-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitNewItem();
          }}
        >
          <input
            value={newItemText}
            onChange={(e) => setNewItemText(e.currentTarget.value)}
            placeholder="添加常用要求"
          />
          <button type="submit" disabled={!newItemText.trim()}>
            添加
          </button>
        </form>
      </section>

      <section className="panel-section">
        <div className="panel-heading">
          <h3>本张备注</h3>
        </div>
        <textarea
          value={note}
          onChange={(e) => onNoteChange(e.currentTarget.value)}
          placeholder="只针对这张照片的说明，会一并写进导出的 PDF"
          rows={5}
        />
      </section>
    </aside>
  );
}
