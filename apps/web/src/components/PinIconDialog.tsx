import { PIN_ICON_CHOICES, setPinIcon } from "../pinIcons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

// Emoji picker for a pinned thread's tile.
export function PinIconDialog(props: {
  threadKey: string | null;
  threadTitle: string;
  onClose: () => void;
}) {
  const choose = (emoji: string | null) => {
    if (props.threadKey !== null) setPinIcon(props.threadKey, emoji);
    props.onClose();
  };
  return (
    <Dialog open={props.threadKey !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Icon for “{props.threadTitle}”</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid grid-cols-6 gap-1.5">
            {PIN_ICON_CHOICES.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => choose(emoji)}
                className="flex aspect-square cursor-pointer items-center justify-center rounded-xl text-2xl hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {emoji}
              </button>
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => choose(null)}>
            Use project icon
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
