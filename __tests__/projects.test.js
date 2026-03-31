const request = require('supertest');
const { setup, cleanDb, teardown, createAuthenticatedUser, createTestProject } = require('./setup');

let app;

beforeAll(async () => {
  const ctx = await setup();
  app = ctx.app;
});

beforeEach(async () => {
  await cleanDb();
});

afterAll(async () => {
  await teardown();
});

describe('POST /api/projects', () => {
  it('should create a project', async () => {
    const user = await createAuthenticatedUser(app);

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'My Project', description: 'Desc here' })
      .expect(201);

    expect(res.body.name).toBe('My Project');
    expect(res.body.description).toBe('Desc here');
    expect(res.body.status).toBe('active');
    expect(res.body.testCaseCount).toBe(0);
    expect(res.body.id).toBeDefined();
  });

  it('should reject empty name', async () => {
    const user = await createAuthenticatedUser(app);

    const res = await request(app)
      .post('/api/projects')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: '' })
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should require authentication', async () => {
    await request(app)
      .post('/api/projects')
      .send({ name: 'Unauthorized' })
      .expect(401);
  });
});

describe('GET /api/projects', () => {
  it('should list only the users projects', async () => {
    const userA = await createAuthenticatedUser(app, 'a@test.com', 'Password123');
    const userB = await createAuthenticatedUser(app, 'b@test.com', 'Password123');

    await createTestProject(app, userA.accessToken, 'A Project');
    await createTestProject(app, userB.accessToken, 'B Project');

    const res = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('A Project');
    expect(res.body.pagination.total).toBe(1);
  });

  it('should filter by status', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken, 'Active One');

    // Archive it
    await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ status: 'archived' });

    await createTestProject(app, user.accessToken, 'Still Active');

    const res = await request(app)
      .get('/api/projects?status=active')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Still Active');
  });

  it('should paginate results', async () => {
    const user = await createAuthenticatedUser(app);

    for (let i = 0; i < 5; i++) {
      await createTestProject(app, user.accessToken, `Project ${i}`);
    }

    const res = await request(app)
      .get('/api/projects?page=1&limit=2')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.limit).toBe(2);
  });
});

describe('GET /api/projects/:id', () => {
  it('should return a single project', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken, 'Single');

    const res = await request(app)
      .get(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body.name).toBe('Single');
  });

  it('should 404 for another users project', async () => {
    const userA = await createAuthenticatedUser(app, 'own@test.com', 'Password123');
    const userB = await createAuthenticatedUser(app, 'other@test.com', 'Password123');

    const project = await createTestProject(app, userA.accessToken, 'Private');

    await request(app)
      .get(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .expect(404);
  });
});

describe('PATCH /api/projects/:id', () => {
  it('should update project fields', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken, 'Original');

    const res = await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ name: 'Updated', status: 'archived' })
      .expect(200);

    expect(res.body.name).toBe('Updated');
    expect(res.body.status).toBe('archived');
  });

  it('should reject invalid status', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken, 'Test');

    await request(app)
      .patch(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ status: 'deleted' })
      .expect(400);
  });
});

describe('DELETE /api/projects/:id', () => {
  it('should delete a project', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken, 'Doomed');

    await request(app)
      .delete(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    // Verify gone
    await request(app)
      .get(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(404);
  });

  it('should not allow deleting another users project', async () => {
    const userA = await createAuthenticatedUser(app, 'del-a@test.com', 'Password123');
    const userB = await createAuthenticatedUser(app, 'del-b@test.com', 'Password123');

    const project = await createTestProject(app, userA.accessToken, 'Not Yours');

    await request(app)
      .delete(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .expect(404);
  });
});
