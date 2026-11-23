import type { Page } from '@playwright/test';

/**
 * Shared behaviour for every page object.
 *
 * Note that `import type` above is erased at compile time, so this file --
 * and every page object extending it -- has **no runtime dependency on the
 * test runner**. That is the whole point of keeping `expect` out of page
 * objects: these classes can be driven by a test, a seed script, or an
 * accessibility scan without dragging Playwright's assertion machinery along.
 */
export abstract class BasePage {
  /**
   * `protected readonly page` is a constructor parameter property: it
   * declares the field, assigns it, and sets its visibility in one place.
   *
   * The constructor is `protected` because `BasePage` is abstract -- only
   * subclasses may call it.
   */
  protected constructor(
    protected readonly page: Page,
    private readonly path: string,
  ) {}

  /** Navigate to this page's own path, resolved against the config `baseURL`. */
  async open(): Promise<void> {
    await this.page.goto(this.path);
  }

  /** Exposed so specs can assert on navigation without reaching for `page`. */
  url(): string {
    return this.page.url();
  }
}
