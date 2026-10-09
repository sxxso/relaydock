"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
  closeDisabled = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
  closeDisabled?: boolean;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => !v && !closeDisabled && onClose()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={"modal-content " + (wide ? "modal-wide" : "")}
          aria-describedby={description ? undefined : undefined}
          onEscapeKeyDown={(e) => {
            if (closeDisabled) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (closeDisabled) e.preventDefault();
          }}
        >
          <div className="modal-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description className={description ? "" : "sr-only"}>
                {description || "编辑内容后保存，或关闭返回。"}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="icon-button"
              aria-label="关闭对话框"
              disabled={closeDisabled}
            >
              <X size={20} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
