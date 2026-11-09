const { test, expect } = require('@playwright/test');

async function openOwnerAdmin(page, adminData = {}) {
  await page.route('**/api/v1/me', route => route.fulfill({ json: {
    authenticated: true,
    is_owner: true,
    account: { id: 'owner-1', email: 'admin@example.com', name: 'Owner' },
    roles: ['administrator'],
    access: 'admin'
  } }));
  await page.route('**/api/v1/admin**', async route => {
    const url = new URL(route.request().url());
    const resource = url.searchParams.get('resource');
    await route.fulfill({ json: { data: adminData[resource] || [] } });
  });
  await page.goto('/#/organizer');
  await expect(page.locator('[data-admin-tab="overview"]')).toBeVisible();
}

test.describe('MERCY ARENA completion flows', () => {
  test('player profile links the real team and restores its overview tab without reloading', async ({ page }) => {
    let documentRequests = 0;
    page.on('request', request => {
      if (request.isNavigationRequest()) documentRequests += 1;
    });
    await page.route('**/api/v1/players?id=123', route => route.fulfill({ json: { data: [{
      id: 123,
      nickname: 'ArenaPlayer',
      game_id: '123456789',
      role: 'MID',
      team_id: 7,
      region: 'EU',
      avatar_url: null,
      stats: { matches_played: 12, wins: 9, losses: 3, points: 27, win_rate: 75 },
      recent_matches: []
    }] } }));
    await page.route('**/api/v1/teams', route => route.fulfill({ json: { data: [
      { id: 7, name: 'MERCY PRIME', tag: 'MP', region: 'EU' }
    ] } }));

    await page.goto('/#/player/123');
    await expect(page.locator('#profileNickname')).toHaveText('ArenaPlayer');
    await page.locator('[data-profile-tab="team"]').click();
    await expect(page.locator('#profileContent')).toContainText('MERCY PRIME');
    await expect(page.locator('#profileContent')).toContainText('Матчи игрока');
    await expect(page.locator('#profileContent a[href="#/team/7"]')).toBeVisible();
    await page.locator('[data-profile-tab="overview"]').click();
    await expect(page.locator('#profileContent')).toContainText('ТУРНИРНЫЙ РЕЙТИНГ');
    expect(documentRequests).toBe(1);
  });

  test('tournament detail exposes a chronological match schedule', async ({ page }) => {
    await page.route('**/api/v1/tournaments?id=778', route => route.fulfill({ json: { data: [{
      id: 778,
      title: 'MERCY Season Cup',
      description: 'Official season event',
      format: 'single_elimination',
      status: 'published',
      region: 'EU',
      starts_at: '2026-11-10T12:00:00Z',
      max_teams: 8,
      registered_teams_list: [
        { id: 1, name: 'Alpha', tag: 'ALP' },
        { id: 2, name: 'Bravo', tag: 'BRV' }
      ]
    }] } }));
    await page.route('**/api/v1/matches?tournament_id=778', route => route.fulfill({ json: { data: [
      { id: 2, tournament_id: 778, bracket: 'main', round_number: 2, match_number: 1, status: 'scheduled', team_a_id: null, team_b_id: 2, scheduled_at: '2026-11-11T14:00:00Z' },
      { id: 1, tournament_id: 778, bracket: 'main', round_number: 1, match_number: 1, status: 'completed', team_a_id: 1, team_b_id: 2, score_a: 2, score_b: 1, scheduled_at: '2026-11-10T14:00:00Z' }
    ] } }));

    await page.goto('/#/tournament/778');
    await page.locator('[data-tournament-tab="schedule"]').click();
    const schedule = page.locator('#tournamentTabContent .tournament-schedule');
    await expect(schedule).toContainText('Alpha');
    await expect(schedule).toContainText('Bravo');
    await expect(schedule).toContainText('Ожидает команду');
    await expect(schedule).toContainText('2 : 1');
    const rows = schedule.locator('.tournament-schedule-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('ЗАВЕРШЁН');
  });

  test('match center uses bracket progression order and readable empty team slots', async ({ page }) => {
    await page.route('**/api/v1/tournaments', route => route.fulfill({ json: { data: [
      { id: 55, title: 'MERCY Test Cup', format: 'double_elimination', status: 'active' }
    ] } }));
    await page.route('**/api/v1/matches', route => route.fulfill({ json: { data: [
      { id: 1, tournament_id: 55, bracket: 'final', round_number: 1, match_number: 1, status: 'scheduled', team_a_id: null, team_b_id: null },
      { id: 2, tournament_id: 55, bracket: 'lower', round_number: 1, match_number: 1, status: 'scheduled', team_a_id: 2, team_b_id: null },
      { id: 3, tournament_id: 55, bracket: 'upper', round_number: 1, match_number: 1, status: 'scheduled', team_a_id: 1, team_b_id: 2 }
    ] } }));
    await page.route('**/api/v1/teams', route => route.fulfill({ json: { data: [
      { id: 1, name: 'Alpha' },
      { id: 2, name: 'Bravo' }
    ] } }));

    await page.goto('/#/brackets');
    await expect(page.locator('#matchBracket')).toContainText('Ожидает команду');
    await expect(page.locator('#matchBracket')).not.toContainText('Команда #null');
    await expect(page.locator('#matchBracket .match-round-title')).toHaveText([
      'Верхняя сетка · РАУНД 1',
      'Нижняя сетка · РАУНД 1',
      'Финал · РАУНД 1'
    ]);
    await page.locator('[data-match-view="schedule"]').click();
    await expect(page.locator('#matchSchedule')).toContainText('MERCY Test Cup');
  });

  test('tournament watch tab embeds a validated YouTube livestream and has an empty state', async ({ page }) => {
    await page.route('**/api/v1/tournaments?id=779', route => route.fulfill({ json: { data: [{
      id: 779,
      title: 'MERCY Live Cup',
      description: 'Live event',
      format: 'single_elimination',
      status: 'active',
      stream_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      registered_teams_list: []
    }] } }));
    await page.route('**/api/v1/matches?tournament_id=779', route => route.fulfill({ json: { data: [] } }));

    await page.goto('/#/tournament/779');
    await page.locator('[data-tournament-tab="watch"]').click();
    await expect(page.locator('#tournamentTabContent iframe')).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
    );
    await expect(page.locator('#tournamentTabContent')).toContainText('ТРАНСЛЯЦИЯ ТУРНИРА');
  });

  test('tournament watch tab does not render an unsafe or missing stream URL', async ({ page }) => {
    await page.route('**/api/v1/tournaments?id=780', route => route.fulfill({ json: { data: [{
      id: 780,
      title: 'MERCY Offline Cup',
      format: 'single_elimination',
      status: 'completed',
      stream_url: 'javascript:alert(1)',
      registered_teams_list: []
    }] } }));
    await page.route('**/api/v1/matches?tournament_id=780', route => route.fulfill({ json: { data: [] } }));

    await page.goto('/#/tournament/780');
    await page.locator('[data-tournament-tab="watch"]').click();
    await expect(page.locator('#tournamentTabContent')).toContainText('Трансляция пока не добавлена');
    await expect(page.locator('#tournamentTabContent iframe')).toHaveCount(0);
  });

  test('owner admin can inspect an immutable audit log', async ({ page }) => {
    await openOwnerAdmin(page, {
      audit: [{
        id: 'audit-1',
        actor_id: 'owner-1',
        actor_email: 'admin@example.com',
        action: 'match_result_corrected',
        entity_type: 'matches',
        entity_id: '42',
        before_json: '{"score_a":1,"score_b":0}',
        after_json: '{"score_a":0,"score_b":1}',
        created_at: '2026-11-07T10:00:00Z'
      }]
    });

    await page.locator('[data-admin-tab="audit"]').click();
    await expect(page.locator('#adminContent')).toContainText('match_result_corrected');
    await expect(page.locator('#adminContent')).toContainText('admin@example.com');
    await page.getByText('Показать', { exact: true }).click();
    await expect(page.locator('.audit-details')).toContainText('"score_a":0');
  });

  test('admin record search filters the current dataset without changing it', async ({ page }) => {
    await openOwnerAdmin(page, {
      players: [
        { id: 1, user_id: 'user-1', nickname: 'AlphaPlayer', game_id: '11111', role: 'MID', team_id: null, profile_status: 'approved' },
        { id: 2, user_id: 'user-2', nickname: 'BravoPlayer', game_id: '22222', role: 'GOLD', team_id: null, profile_status: 'pending' }
      ],
      users: [
        { id: 'user-1', email: 'alpha@example.com', display_name: 'Alpha' },
        { id: 'user-2', email: 'bravo@example.com', display_name: 'Bravo' }
      ]
    });

    await page.locator('[data-admin-tab="players"]').click();
    const rows = page.locator('[data-admin-row]');
    await expect(rows).toHaveCount(2);
    await page.locator('#adminTableSearch').fill('BravoPlayer');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toBeHidden();
    await expect(rows.nth(1)).toBeVisible();
    await expect(page.locator('#adminTableCount')).toContainText('1 из 2');
  });
});
