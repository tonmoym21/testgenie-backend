const request = require('supertest');
const {
  setup,
  cleanDb,
  teardown,
  createAuthenticatedUser,
  createTestProject,
  createTestCase,
} = require('./setup');

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

describe('POST /api/projects/:projectId/testcases', () => {
  it('should create a test case', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    const res = await request(app)
      .post(`/api/projects/${project.id}/testcases`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        title: 'Login with valid credentials',
        content: 'Step 1: Navigate to login. Step 2: Enter valid creds. Step 3: Click submit.',
        priority: 'high',
      })
      .expect(201);

    expect(res.body.title).toBe('Login with valid credentials');
    expect(res.body.status).toBe('draft');
    expect(res.body.priority).toBe('high');
    expect(res.body.aiAnalysis).toBeNull();
  });

  it('should reject content over 10000 chars', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    await request(app)
      .post(`/api/projects/${project.id}/testcases`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        title: 'Too long',
        content: 'x'.repeat(10001),
      })
      .expect(400);
  });

  it('should 404 for a project the user does not own', async () => {
    const userA = await createAuthenticatedUser(app, 'tc-a@test.com', 'Password123');
    const userB = await createAuthenticatedUser(app, 'tc-b@test.com', 'Password123');
    const project = await createTestProject(app, userA.accessToken);

    await request(app)
      .post(`/api/projects/${project.id}/testcases`)
      .set('Authorization', `Bearer ${userB.accessToken}`)
      .send({ title: 'Sneaky', content: 'Should not work' })
      .expect(404);
  });
});

describe('POST /api/projects/:projectId/testcases/batch', () => {
  it('should batch create test cases', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    const testCases = [
      { title: 'TC 1', content: 'Content 1', priority: 'high' },
      { title: 'TC 2', content: 'Content 2', priority: 'low' },
      { title: 'TC 3', content: 'Content 3' },
    ];

    const res = await request(app)
      .post(`/api/projects/${project.id}/testcases/batch`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ testCases })
      .expect(201);

    expect(res.body.created).toBe(3);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[2].priority).toBe('medium'); // default
  });

  it('should reject batch over 50 items', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    const testCases = Array.from({ length: 51 }, (_, i) => ({
      title: `TC ${i}`,
      content: `Content ${i}`,
    }));

    await request(app)
      .post(`/api/projects/${project.id}/testcases/batch`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ testCases })
      .expect(400);
  });

  it('should reject empty batch', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    await request(app)
      .post(`/api/projects/${project.id}/testcases/batch`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ testCases: [] })
      .expect(400);
  });
});

describe('GET /api/projects/:projectId/testcases', () => {
  it('should list test cases with pagination', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    for (let i = 0; i < 5; i++) {
      await createTestCase(app, user.accessToken, project.id, { title: `TC ${i}` });
    }

    const res = await request(app)
      .get(`/api/projects/${project.id}/testcases?page=1&limit=2`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(5);
  });

  it('should filter by status', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    const tc = await createTestCase(app, user.accessToken, project.id);
    await createTestCase(app, user.accessToken, project.id);

    // Update one to active
    await request(app)
      .patch(`/api/projects/${project.id}/testcases/${tc.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ status: 'active' });

    const res = await request(app)
      .get(`/api/projects/${project.id}/testcases?status=active`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('active');
  });

  it('should filter by priority', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    await createTestCase(app, user.accessToken, project.id, { priority: 'critical' });
    await createTestCase(app, user.accessToken, project.id, { priority: 'low' });

    const res = await request(app)
      .get(`/api/projects/${project.id}/testcases?priority=critical`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].priority).toBe('critical');
  });
});

describe('PATCH /api/projects/:projectId/testcases/:id', () => {
  it('should update test case fields', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);
    const tc = await createTestCase(app, user.accessToken, project.id);

    const res = await request(app)
      .patch(`/api/projects/${project.id}/testcases/${tc.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ title: 'Updated title', status: 'passed', priority: 'critical' })
      .expect(200);

    expect(res.body.title).toBe('Updated title');
    expect(res.body.status).toBe('passed');
    expect(res.body.priority).toBe('critical');
  });

  it('should reject invalid status value', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);
    const tc = await createTestCase(app, user.accessToken, project.id);

    await request(app)
      .patch(`/api/projects/${project.id}/testcases/${tc.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ status: 'invalid_status' })
      .expect(400);
  });
});

describe('DELETE /api/projects/:projectId/testcases/:id', () => {
  it('should delete a test case', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);
    const tc = await createTestCase(app, user.accessToken, project.id);

    await request(app)
      .delete(`/api/projects/${project.id}/testcases/${tc.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    // Verify gone
    const res = await request(app)
      .get(`/api/projects/${project.id}/testcases`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(0);
  });

  it('should cascade delete when project is deleted', async () => {
    const user = await createAuthenticatedUser(app);
    const project = await createTestProject(app, user.accessToken);

    await createTestCase(app, user.accessToken, project.id);
    await createTestCase(app, user.accessToken, project.id);

    // Delete the project
    await request(app)
      .delete(`/api/projects/${project.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    // Project is gone, so listing test cases should 404
    await request(app)
      .get(`/api/projects/${project.id}/testcases`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(404);
  });
});
