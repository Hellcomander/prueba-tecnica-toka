/** Base de agregados: acumula eventos de dominio que la capa de aplicación publica tras el commit. */
export abstract class AggregateRoot<TEvent> {
  private events: TEvent[] = [];

  protected record(event: TEvent): void {
    this.events.push(event);
  }

  pullDomainEvents(): TEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }
}
