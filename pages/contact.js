const button = document.querySelector("#contact-demo-button");
const output = document.querySelector("#contact-demo-output");

if (button && output) {
  button.addEventListener("click", () => {
    output.textContent = "That click came from ordinary JavaScript.";
  });
}