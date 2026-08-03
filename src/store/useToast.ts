import { create } from "zustand";

export type ToastTone = "info" | "error";

interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

interface ToastState {
  toast: Toast | null;
  /**
   * 统一的轻提示入口。
   * 设计原则：任何被拒绝或无效的操作都要给反馈——按键没反应会让人以为程序坏了。
   */
  notify: (text: string, tone?: ToastTone) => void;
  dismiss: () => void;
}

let seq = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export const useToast = create<ToastState>((set, get) => ({
  toast: null,

  notify(text, tone = "info") {
    // 同一条提示连续触发（比如一直按方向键顶到边界）只刷新计时，不闪烁重建
    const current = get().toast;
    const id = current && current.text === text && current.tone === tone ? current.id : ++seq;

    set({ toast: { id, text, tone } });
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => set({ toast: null }), tone === "error" ? 5000 : 1800);
  },

  dismiss() {
    if (timer) clearTimeout(timer);
    set({ toast: null });
  },
}));

/** 供非组件代码调用 */
export const notify = (text: string, tone?: ToastTone) => useToast.getState().notify(text, tone);
