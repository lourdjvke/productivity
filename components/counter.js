export function mount({ root, props, signal }) {
  const output = root.querySelector("[data-count]");
  const button = root.querySelector("[data-increment]");
  let count = Number(props.start ?? 0);

  if (!Number.isFinite(count)) count = 0;
  output.value = String(count);

  const increase = () => {
    count += 1;
    output.value = String(count);
  };
  button.addEventListener("click", increase, { signal });

  return {
    update(context) {
      if (!Object.hasOwn(context.props, "start")) return;
      const next = Number(context.props.start);
      if (!Number.isFinite(next)) return;
      count = next;
      output.value = String(count);
    },
    unmount() {
      button.removeEventListener("click", increase);
    },
  };
}