import { useId, useRef, useState, type ComponentProps } from "react";
import { Loader2Icon } from "lucide-react";
import { ChangeBadge } from "@/components/p4/change-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "react-i18next";

export type ChangeDialogRequest = { id: string; description: string; mode: "edit" | "submit" | "submitShelf" };

export function P4ChangeDialog({
  request,
  openedCount,
  openedStream = false,
  shelved = false,
  onManageShelf,
  available,
  busy,
  onConfirm,
  onClose,
  onCloseAutoFocus,
}: {
  request: ChangeDialogRequest;
  openedCount: number;
  openedStream?: boolean;
  shelved?: boolean;
  onManageShelf?: () => void;
  available: boolean;
  busy: boolean;
  onConfirm: (description: string) => Promise<boolean>;
  onClose: () => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}) {
  const { t } = useTranslation();
  const descriptionId = useId();
  const [description, setDescription] = useState(request.description);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const running = useRef(false);
  const submitting = request.mode !== "edit";
  const submittingShelf = request.mode === "submitShelf";
  const blocked = busy || working;
  const canConfirm = available && (submittingShelf ? shelved && openedCount === 0 && !openedStream : !submitting || (openedCount > 0 || openedStream) && !shelved) && !!description.trim();

  async function confirm() {
    if (blocked || running.current || !canConfirm) return;
    running.current = true;
    setWorking(true);
    setFailed(false);
    try {
      if (await onConfirm(description)) onClose();
      else setFailed(true);
    } finally {
      running.current = false;
      setWorking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !running.current && onClose()}>
      <DialogContent className="sm:max-w-lg" showCloseButton={!working} onCloseAutoFocus={onCloseAutoFocus}>
        <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
          <DialogHeader>
            <DialogTitle>{t(submittingShelf ? "p4.submitShelf" : submitting ? "p4.changeDialog.submitTitle" : "p4.changeDialog.editTitle")}</DialogTitle>
            <DialogDescription>
              {t(submittingShelf ? "p4.changeDialog.submitShelfDescription" : submitting ? openedStream ? "p4.streamWork.submitHint" : "p4.changeDialog.submitDescription" : request.id === "default" ? "p4.changeDialog.defaultDescription" : "p4.changeDialog.editDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ChangeBadge id={request.id} />
            <span>{t("p4.changeDialog.openedFiles", { count: openedCount })}{openedStream ? ` · ${t("p4.streamWork.title")}` : ""}</span>
          </div>
          <div className="grid gap-2">
            <label htmlFor={descriptionId} className="text-sm font-medium">{t("p4.description")}</label>
            <Textarea
              id={descriptionId}
              autoFocus
              className="min-h-32 max-h-64"
              value={description}
              disabled={blocked}
              onChange={(event) => { setDescription(event.target.value); setFailed(false); }}
            />
          </div>
          {submitting && !submittingShelf && shelved ? <div className="grid gap-2"><p role="alert" className="text-xs text-muted-foreground">{t("p4.changeDialog.shelvedSubmit")}</p>{onManageShelf ? <Button variant="outline" size="sm" className="justify-self-start" disabled={blocked} onClick={onManageShelf}>{t("p4.deleteShelf")}</Button> : null}</div> : null}
          {submittingShelf && (openedCount > 0 || openedStream) ? <p role="alert" className="text-xs text-muted-foreground">{t("p4.changeDialog.submitShelfOpened")}</p> : null}
          {!available ? <p role="alert" className="text-sm text-destructive">{t("p4.changeDialog.unavailable")}</p> : null}
          {failed ? <p role="alert" className="text-sm text-destructive">{t("p4.changeDialog.failed")}</p> : null}
          <DialogFooter>
            <Button variant="outline" disabled={working} onClick={onClose}>{t("p4.cancel")}</Button>
            <Button type="submit" disabled={blocked || !canConfirm}>
              {working ? <Loader2Icon className="animate-spin" /> : null}
              {t(working ? submitting ? "p4.submitting" : "p4.savingChangelist" : submittingShelf ? "p4.submitShelf" : submitting ? "p4.submitChangelist" : "p4.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
