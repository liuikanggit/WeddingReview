interface Props {
  fileName: string;
  thumbSrc?: string;
  markCount: number;
  onClick: () => void;
  /** 鼠标移上来就开始准备大图——用户点下去时往往已经就绪 */
  onHover?: () => void;
}

/**
 * 注意：这里刻意不用 <button>。WebKit 给 button 套了一层匿名内部布局盒，
 * 子元素的 aspect-ratio 会失效、内容会被压扁，所以用 div 自己补齐键盘可达性。
 */
export default function PhotoThumb({ fileName, thumbSrc, markCount, onClick, onHover }: Props) {
  const marked = markCount > 0;
  return (
    <div
      className={`photo-thumb ${marked ? "marked" : ""}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={onHover}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={fileName}
    >
      <div className="thumb-frame">
        {thumbSrc ? (
          <img src={thumbSrc} alt={fileName} loading="lazy" draggable={false} />
        ) : (
          <div className="thumb-placeholder" />
        )}
      </div>
      <div className="thumb-caption">
        <span className="thumb-name">{fileName}</span>
        {marked && <span className="thumb-badge">{markCount}</span>}
      </div>
    </div>
  );
}
