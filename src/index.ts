/**
 * Application entry point. Replace this scaffold as the product takes shape.
 */
export function greet(name: string): string {
  return `hello, ${name}`;
}

if (import.meta.main) {
  console.log(greet('hivemind'));
}
