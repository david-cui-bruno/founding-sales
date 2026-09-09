import type { MouseEvent } from 'react';

import { navigationItems, type NavigationItem } from './navigationItems';
import { routeHash, type AppRoute } from './routes';

export type NavigationRailProps = {
  route: AppRoute;
  onNavigate(route: AppRoute): void;
  reviewCount: number;
};

/**
 * Fixed primary navigation. Anchors are real hash links handled in-window;
 * unbuilt destinations stay visible but disabled instead of routing to blank
 * screens.
 */
export function NavigationRail({
  route,
  onNavigate,
  reviewCount,
}: NavigationRailProps) {
  const onItemClick =
    (item: NavigationItem) => (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (item.enabled) {
        onNavigate(item.route);
      }
    };

  const renderItem = (item: NavigationItem) => {
    const Icon = item.icon;
    const current = item.route === route;

    return (
      <li key={item.route}>
        <a
          className={
            current
              ? 'nav-rail__item nav-rail__item--current'
              : 'nav-rail__item'
          }
          href={routeHash(item.route)}
          aria-current={current ? 'page' : undefined}
          aria-disabled={item.enabled ? undefined : 'true'}
          title={item.enabled ? undefined : `${item.label} is coming soon`}
          onClick={onItemClick(item)}
        >
          <Icon className="nav-rail__icon" aria-hidden="true" size={16} />
          <span className="nav-rail__label">{item.label}</span>
          {item.route === 'inbox' && reviewCount > 0 && (
            <span className="nav-rail__badge" aria-label={`${reviewCount} items awaiting review`}>
              {reviewCount}
            </span>
          )}
        </a>
      </li>
    );
  };

  const primaryItems = navigationItems.filter((item) => item.route !== 'settings');
  const settingsItems = navigationItems.filter((item) => item.route === 'settings');

  return (
    <nav className="nav-rail" aria-label="Primary">
      <div className="nav-rail__native-controls" aria-hidden="true" />
      <div className="nav-rail__header">
        <p className="nav-rail__brand" aria-hidden="true">
          FSS
        </p>
        <p className="nav-rail__brand-native" aria-hidden="true">Callie</p>
      </div>
      <ul className="nav-rail__list">{primaryItems.map(renderItem)}</ul>
      <div className="nav-rail__spacer" aria-hidden="true" />
      <ul className="nav-rail__list">{settingsItems.map(renderItem)}</ul>
    </nav>
  );
}
