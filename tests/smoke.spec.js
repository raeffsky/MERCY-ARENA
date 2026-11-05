const { test, expect } = require('@playwright/test');

test.describe('MERCY ARENA public shell', () => {
  test('renders the season hub, match center and team ladder', async ({ page }) => {
    const runtimeErrors = [];
    page.on('pageerror', error => runtimeErrors.push(error.message));
    await page.goto('/');
    await expect(page).toHaveTitle(/MERCY ARENA/);
    await expect(page.locator('#app')).toContainText('СЕЗОНЫ И ТУРНИРЫ');
    await expect(page.locator('#homeMatches')).toBeVisible();
    await expect(page.locator('#homeRankings')).toBeVisible();
    await expect(page.locator('#homeMatches')).toContainText(/DEMO|Демо-матч|Расписание временно недоступно/);
    expect(runtimeErrors).toEqual([]);
  });



  test('player registration accepts numeric MLBB and server IDs before lookup', async ({ page }) => {
    await page.route('**/api/v1/players**', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/v1/teams**', route => route.fulfill({ json: { data: [] } }));
    let lookupPayload = null;
    await page.route('**/api/v1/mlbb-lookup', async route => {
      lookupPayload = route.request().postDataJSON();
      await route.fulfill({ json: { data: { game_id: '123456789', server_id: '1234', nickname: 'TestPlayer', verified: true } } });
    });

    await page.goto('/#/players');
    await page.getByRole('button', { name: /Создать профиль/ }).click();
    await page.locator('#playerCreateForm [name="game_id"]').fill('123456789');
    await page.locator('#playerCreateForm [name="server_id"]').fill('1234');
    await page.getByRole('button', { name: 'Проверить игровой аккаунт' }).click();

    await expect.poll(() => lookupPayload).toEqual({ game_id: '123456789', server_id: '1234' });
    await expect(page.locator('#submitPlayerRegistration')).toBeEnabled();
    await expect(page.locator('#mlbbLookupResult')).toContainText('TestPlayer');
  });


  test('player registration can be submitted for manual review when MLBB lookup fails', async ({ page }) => {
    let registrationBody = null;
    await page.route('**/api/v1/players**', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/v1/teams**', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/v1/mlbb-lookup', route => route.fulfill({
      status: 422,
      json: { error: { code: 'MLBB_PLAYER_NOT_FOUND', message: 'Автоматическая проверка не нашла аккаунт.' } }
    }));
    await page.route('**/api/v1/auth/register', async route => {
      registrationBody = route.request().postDataJSON();
      await route.fulfill({ status: 201, json: {
        authenticated: true,
        account: { id: 'user-2', email: 'manual@example.com', name: 'ManualPlayer' },
        profile: { id: 'player-2', status: 'pending', nickname: 'ManualPlayer', game_id: '123456789', server_id: '1234' }
      } });
    });
    await page.goto('/#/players');
    await page.getByRole('button', { name: /Создать профиль/ }).click();
    await page.locator('#playerCreateForm [name="email"]').fill('manual@example.com');
    await page.locator('#playerCreateForm [name="password"]').fill('VeryStrongPassword123!');
    await page.locator('#playerCreateForm [name="game_id"]').fill('123456789');
    await page.locator('#playerCreateForm [name="server_id"]').fill('1234');
    await page.locator('#playerCreateForm [name="role"]').selectOption('MID');
    await page.getByRole('button', { name: 'Проверить игровой аккаунт' }).click();
    await expect(page.locator('#manualNicknameWrap')).toBeVisible();
    await page.locator('#playerCreateForm [name="nickname"]').fill('ManualPlayer');
    await page.getByRole('button', { name: 'Отправить на ручную проверку' }).click();
    await page.getByRole('button', { name: 'Создать аккаунт и профиль' }).click();
    await expect.poll(() => registrationBody?.manual_review).toBe(true);
    await expect(page.locator('#playerCreateMessage')).toContainText('отправлен на ручную проверку');
  });

  test('player account exposes logout and clears the session', async ({ page }) => {
    let meCalls = 0;
    let logoutCalls = 0;
    await page.route('**/api/v1/me', async route => {
      meCalls += 1;
      await route.fulfill({ json: meCalls === 1 ? {
        authenticated: true,
        account: { id: 'user-1', email: 'player@example.com', name: 'Player' },
        profile: { id: 12, nickname: 'PlayerOne', game_id: '123456789', server_id: '1234', role: 'MID', region: 'EU', profile_status: 'approved' },
        roles: [], access: 'user'
      } : { authenticated: false, account: null, roles: [], access: 'guest' } });
    });
    await page.route('**/api/v1/team-members', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/v1/auth/logout', async route => {
      logoutCalls += 1;
      expect(route.request().method()).toBe('POST');
      await route.fulfill({ json: { ok: true }, headers: { 'set-cookie': 'mercy_session=; Path=/; Max-Age=0' } });
    });

    await page.goto('/#/my-profile');
    const logoutButton = page.getByRole('button', { name: /Выйти из аккаунта/ });
    await expect(logoutButton).toBeVisible();
    await logoutButton.click();
    await expect.poll(() => logoutCalls).toBe(1);
    await expect(page).toHaveURL(/#\\/home$/);
  });


  test('public player profile displays verified match statistics', async ({ page }) => {
    await page.route(/\/api\/v1\/players\?id=123$/, route => route.fulfill({ json: { data: [{
      id: 123, nickname: 'ArenaPlayer', game_id: '123456789', role: 'MID', team_id: null,
      region: 'EU', avatar_url: null,
      stats: { matches_played: 12, wins: 9, losses: 3, points: 27, win_rate: 75 },
      recent_matches: [{ id: 1, opponent_name: 'Team B', tournament_title: 'Season Cup', scheduled_at: '2026-11-01T12:00:00Z', outcome: 'win', player_score: 2, opponent_score: 0 }]
    }] } }));
    await page.route('**/api/v1/teams**', route => route.fulfill({ json: { data: [] } }));

    await page.goto('/#/player/123');
    await expect(page.locator('#profileNickname')).toHaveText('ArenaPlayer');
    await expect(page.locator('#profileMmr')).toHaveText('12');
    await expect(page.locator('#profileBpr')).toHaveText('9');
    await expect(page.locator('#profileLevel')).toHaveText('27');
    await expect(page.locator('#profileKda')).toHaveText('75%');
    await page.locator('[data-profile-tab="history"]').click();
    await expect(page.locator('.profile-match-row')).toContainText('Team B');
    await expect(page.locator('.profile-match-row')).toContainText('2 : 0');
  });


  test('seasonal team rankings retain teams with zero verified matches', async ({ page }) => {
    const rankingRequests = [];
    await page.route('**/api/v1/seasons?limit=50', route => route.fulfill({ json: { data: [
      { id: 'season-1', title: 'Season One', status: 'active', starts_at: '2026-11-01' }
    ] } }));
    await page.route('**/api/v1/rankings**', async route => {
      const url = new URL(route.request().url());
      rankingRequests.push(url.search);
      if (url.searchParams.get('scope') === 'teams') {
        await route.fulfill({ json: { data: [
          { id: 42, name: 'Zero Match Club', tag: 'ZMC', matches_played: 0, wins: 0, losses: 0, points: 0, win_rate: 0 }
        ] } });
      } else {
        await route.fulfill({ json: { data: [] } });
      }
    });
    await page.route('**/api/v1/teams**', route => route.fulfill({ json: { data: [] } }));

    await page.goto('/#/rankings');
    await page.locator('[data-ranking-scope="teams"]').click();
    await expect(page.locator('#rankingRows')).toContainText('Zero Match Club');
    await page.locator('#rankingSeason').selectOption('season-1');
    await expect.poll(() => rankingRequests.some(q => q.includes('scope=teams') && q.includes('season_id=season-1'))).toBe(true);
    await expect(page.locator('#rankingRows')).toContainText('Zero Match Club');
    await expect(page.locator('#rankingRows')).toContainText('0');
  });


  test('season hub displays season metrics and linked tournaments', async ({ page }) => {
    await page.route('**/api/v1/seasons?id=season-2', route => route.fulfill({ json: { data: [{
      id: 'season-2', title: 'MERCY Season Two', status: 'active',
      starts_at: '2026-11-01T12:00:00Z', ends_at: '2026-11-30T12:00:00Z',
      image_url: null, tournaments_count: 2, matches_count: 14, verified_matches_count: 9
    }] } }));
    await page.route('**/api/v1/tournaments?season_id=season-2&limit=100', route => route.fulfill({ json: { data: [{
      id: 88, title: 'Season Cup', format: 'single_elimination', status: 'published',
      region: 'EU', starts_at: '2026-11-10T12:00:00Z', max_teams: 8
    }] } }));
    await page.goto('/#/season/season-2');
    await expect(page.locator('#seasonTournaments')).toContainText('MERCY Season Two');
    await expect(page.locator('#seasonTournaments')).toContainText('ТУРНИРЫ');
    await expect(page.locator('#seasonTournaments')).toContainText('14');
    await expect(page.locator('#seasonTournaments')).toContainText('ПОДТВЕРЖДЕНО');
    await expect(page.locator('#seasonTournaments')).toContainText('Season Cup');
  });

  test('tournament application loads captain teams and available roster', async ({ page }) => {
    await page.route('**/api/v1/tournaments?id=778', route => route.fulfill({ json: { data: [{
      id: 778, title: 'Application Test Cup', format: 'single_elimination', status: 'published',
      registered_teams_list: [], max_teams: 8, registration_slots: null
    }] } }));
    await page.route('**/api/v1/matches?tournament_id=778', route => route.fulfill({ json: { data: [] } }));
    await page.route('**/api/v1/applications?tournament_id=778', route => route.fulfill({ json: { data: [{
      id: 19, name: 'HAFORS', tag: 'HS', application_status: null, available_slots: [],
      available_players: [
        { id: 1, nickname: 'PlayerOne', role: 'GOLD' },
        { id: 2, nickname: 'PlayerTwo', role: 'MID' },
        { id: 3, nickname: 'PlayerThree', role: 'JUNGLE' },
        { id: 4, nickname: 'PlayerFour', role: 'EXP' },
        { id: 5, nickname: 'PlayerFive', role: 'ROAM' }
      ]
    }] } }));
    await page.goto('/#/tournament/778');
    await page.getByRole('button', { name: 'Подать заявку' }).click();
    await expect(page.locator('#applicationTeam')).toContainText('HAFORS [HS]');
    await page.locator('#applicationTeam').selectOption('19');
    await expect(page.locator('#applicationRoster option')).toHaveCount(5);
    await expect(page.locator('#applicationRosterHint')).toContainText('Выбрано: 5');
    await expect(page.locator('#applicationMessage')).toBeEmpty();
  });

  test('double elimination bracket distinguishes upper, lower and grand final matches', async ({ page }) => {
    await page.route('**/api/v1/tournaments?id=777', route => route.fulfill({ json: { data: [{
      id: 777, title: 'Double Elimination Cup', format: 'double_elimination', status: 'active',
      registered_teams_list: [
        { id: 1, name: 'Alpha', tag: 'ALP' },
        { id: 2, name: 'Bravo', tag: 'BRV' }
      ]
    }] } }));
    await page.route('**/api/v1/matches?tournament_id=777', route => route.fulfill({ json: { data: [
      { id: 1, bracket: 'upper', round_number: 1, match_number: 1, status: 'completed', team_a_id: 1, team_b_id: 2, score_a: 2, score_b: 0, winner_team_id: 1 },
      { id: 2, bracket: 'lower', round_number: 1, match_number: 1, status: 'scheduled', team_a_id: 2, team_b_id: null },
      { id: 3, bracket: 'final', round_number: 1, match_number: 1, status: 'scheduled', team_a_id: null, team_b_id: null }
    ] } }));
    await page.goto('/#/tournament/777');
    await page.locator('[data-tournament-tab="bracket"]').click();
    await expect(page.locator('#tournamentTabContent')).toContainText('ВЕРХНЯЯ СЕТКА');
    await expect(page.locator('#tournamentTabContent')).toContainText('НИЖНЯЯ СЕТКА');
    await expect(page.locator('#tournamentTabContent')).toContainText('ГРАНД-ФИНАЛ');
  });

  test('notifications route renders a useful signed-out state', async ({ page }) => {
    await page.goto('/#/notifications');
    await expect(page.locator('#app')).toContainText('УВЕДОМЛЕНИЯ');
    await expect(page.locator('#notificationsRoot')).toBeVisible();
  });

  test('mobile menu opens, navigates and closes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const open = page.getByRole('button', { name: 'Открыть меню' });
    await expect(open).toBeVisible();
    await open.click();

    const drawer = page.locator('#drawer');
    await expect(drawer).toHaveClass(/open/);
    await drawer.getByRole('link', { name: /Игроки/ }).click();
    await expect(page).toHaveURL(/#\/players$/);
    await expect(drawer).not.toHaveClass(/open/);
    await expect(page.locator('#app')).toContainText('ИГРОКИ');
  });

  test('drawer can be dismissed with its close control and backdrop', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Открыть меню' }).click();
    await page.getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);

    await page.getByRole('button', { name: 'Открыть меню' }).click();
    await page.locator('#shade').click({ position: { x: 8, y: 400 } });
    await expect(page.locator('#drawer')).not.toHaveClass(/open/);
  });
});
