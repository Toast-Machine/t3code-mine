import { PIN_EMOJI_CHOICES, setPinIcon } from "../pinIcons";
import { PIN_LINE_ICONS } from "./pinLineIcons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const choiceClassName =
  "flex aspect-square cursor-pointer items-center justify-center rounded-xl hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

// Icon picker for a pinned thread's tile: line icons first, emoji second.
export function PinIconDialog(props: {
  threadKey: string | null;
  threadTitle: string;
  onClose: () => void;
}) {
  const choose = (value: string | null) => {
    if (props.threadKey !== null) setPinIcon(props.threadKey, value);
    props.onClose();
  };
  return (
    <Dialog open={props.threadKey !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Icon for “{props.threadTitle}”</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <div>
              <div className="mb-1.5 text-xs font-semibold text-muted-foreground">Icons</div>
              <div className="grid grid-cols-8 gap-1">
                {PIN_LINE_ICONS.map(([name, Icon]) => (
                  <button
                    key={name}
                    type="button"
                    aria-label={name}
                    onClick={() => choose(`icon:${name}`)}
                    className={choiceClassName}
                  >
                    <Icon className="size-5 text-foreground/80" />
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-xs font-semibold text-muted-foreground">Emoji</div>
              <div className="grid grid-cols-8 gap-1">
                {PIN_EMOJI_CHOICES.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => choose(emoji)}
                    className={`${choiceClassName} text-xl`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
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
