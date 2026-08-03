/** 会生成标注图形的工具 */
export type ShapeTool = "pen" | "arrow" | "rect" | "text";

/** 工具栏上的全部工具：移动只用于选中/搬动已有标注，不产生新图形 */
export type EditorTool = "move" | ShapeTool;

interface ShapeBase {
  id: string;
  tool: ShapeTool;
  color: string;
}

export interface PenShape extends ShapeBase {
  tool: "pen";
  points: number[];
  strokeWidth: number;
}

export interface ArrowShape extends ShapeBase {
  tool: "arrow";
  points: number[]; // [x1, y1, x2, y2]
  strokeWidth: number;
}

export interface RectShape extends ShapeBase {
  tool: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  strokeWidth: number;
}

export interface TextShape extends ShapeBase {
  tool: "text";
  x: number;
  y: number;
  text: string;
  fontSize: number;
}

export type AnnotationShape = PenShape | ArrowShape | RectShape | TextShape;
