// Moving between the steps of a flow (choosing a password manager, then setting it up): one card
// whose content changes in place. The new step fades in while the card eases to its height (its top
// stays put, so it grows and shrinks at the bottom). Every replacement of a step's content
// animates, whichever code made it.

const DURATION = 220;
const EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/** Animates `container` whenever the content of it, or of a step inside it (`selector`), is replaced. */
export function animateSteps(container: HTMLElement, selector = ".setup"): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let height = container.getBoundingClientRect().height;
  new ResizeObserver(() => {
    height = container.getBoundingClientRect().height;
  }).observe(container);

  new MutationObserver((records) => {
    // a whole step swapped: content removed and added at the container or a step's root
    const swapped = records.find(
      (r) =>
        r.addedNodes.length > 0 &&
        r.removedNodes.length > 0 &&
        (r.target === container || (r.target as Element).matches?.(selector)),
    );
    if (!swapped) return;
    const from = height;
    const to = container.getBoundingClientRect().height;
    const target = swapped.target === container ? container : (swapped.target as HTMLElement);
    for (const child of target.children) {
      (child as HTMLElement).animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION, easing: "ease-out" });
    }
    if (Math.abs(from - to) > 1) {
      container.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: DURATION, easing: EASING });
    }
  }).observe(container, { childList: true, subtree: true });
}
