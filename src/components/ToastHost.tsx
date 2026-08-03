import { useToast } from "../store/useToast";

/** 全局轻提示的唯一出口，挂在 App 根部 */
export default function ToastHost() {
  const toast = useToast((s) => s.toast);
  if (!toast) return null;
  return (
    <div key={toast.id} className={`toast ${toast.tone === "error" ? "error" : ""}`} role="status">
      {toast.text}
    </div>
  );
}
