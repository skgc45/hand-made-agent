/** transport が積み、Agent が drain する。pi の steering / follow-up キューと同じ役目 */
export class MessageQueue {
  private items: string[] = [];

  push(text: string): void {
    this.items.push(text);
  }

  drain(): string[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}
