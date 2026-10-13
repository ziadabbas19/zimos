'use strict';

const crypto = require('crypto');
const db = require('../../db/models');
const env = require('../../config/env');
const logger = require('../../core/utils/logger');
const slugify = require('../../core/utils/slugify');
const { scoped } = require('../../core/utils/scopedRepository');
const { normalizePhone } = require('../../core/utils/phone');
const { AppError, NotFoundError, AuthenticationError } = require('../../core/errors/AppError');
const { recordAudit } = require('../audit/auditService');
const otpService = require('../otp/otpService');
const { getStorage } = require('../media/storage');

/**
 * Courses (SPEC §18.3): courses → modules → lessons, sold through a product.
 * Paying for the product enrolls the buyer; the student signs in on the store
 * with their phone and a code, and sees the lessons that are released for
 * them (drip: N days after they enrolled). A free-preview lesson is open to
 * anyone.
 *
 * A video lesson is a link to an external player (YouTube, Vimeo, Bunny…).
 * Protected video streaming is an open decision of the spec and is not built.
 */

const OTP_PURPOSE = 'student_portal';
const PORTAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------- views --

function lessonView(l, { withContent = true } = {}) {
  return {
    id: l.id,
    moduleId: l.moduleId,
    title: l.title,
    kind: l.kind,
    durationSeconds: l.durationSeconds,
    isFreePreview: l.isFreePreview,
    dripDays: l.dripDays,
    position: l.position,
    ...(withContent
      ? { videoUrl: l.videoUrl, body: l.body, fileId: l.fileId, fileName: l.file ? l.file.name : null }
      : {}),
  };
}

function outlineOf(course, options) {
  const lessons = [...(course.lessons || [])].sort((a, b) => a.position - b.position);
  return [...(course.modules || [])]
    .sort((a, b) => a.position - b.position)
    .map((m) => ({
      id: m.id,
      title: m.title,
      position: m.position,
      lessons: lessons.filter((l) => l.moduleId === m.id).map((l) => lessonView(l, options)),
    }));
}

function courseView(course, extra = {}) {
  return {
    id: course.id,
    title: course.title,
    slug: course.slug,
    description: course.description,
    coverUrl: course.coverUrl,
    status: course.status,
    productId: course.productId,
    createdAt: course.createdAt,
    ...extra,
  };
}

const TREE = () => [
  { model: db.CourseModule, as: 'modules' },
  { model: db.Lesson, as: 'lessons', include: [{ model: db.DigitalFile, as: 'file', attributes: ['id', 'name'] }] },
];

// ------------------------------------------------------------------- staff --

async function freeSlug(workspaceId, wanted, exceptId) {
  const cleaned = slugify(wanted || '').replace(/^-+|-+$/g, '');
  const base = /[a-z0-9]/i.test(cleaned) && cleaned !== 'workspace' ? cleaned.slice(0, 100) : 'course';
  for (let n = 1; ; n += 1) {
    const slug = n === 1 ? base : `${base}-${n}`;
    // eslint-disable-next-line no-await-in-loop
    const taken = await db.Course.findOne({ where: { workspaceId, slug }, attributes: ['id'] });
    if (!taken || taken.id === exceptId) return slug;
  }
}

async function listCourses(workspaceId) {
  const courses = await db.Course.findAll({ where: { workspaceId }, order: [['createdAt', 'DESC']] });
  const ids = courses.map((c) => c.id);
  const count = async (model, extra = {}) => {
    if (ids.length === 0) return new Map();
    const rows = await model.findAll({
      where: { courseId: ids, ...extra },
      attributes: ['courseId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
      group: ['courseId'],
      raw: true,
    });
    return new Map(rows.map((r) => [r.courseId, Number(r.n)]));
  };
  const [lessons, students] = await Promise.all([count(db.Lesson), count(db.Enrollment, { revokedAt: null })]);
  return { courses: courses.map((c) => courseView(c, { lessonsCount: lessons.get(c.id) || 0, studentsCount: students.get(c.id) || 0 })) };
}

async function loadCourse(workspaceId, courseId) {
  const course = await db.Course.findOne({ where: { id: courseId, workspaceId }, include: TREE() });
  if (!course) throw new NotFoundError('Course');
  return course;
}

async function getCourse(workspaceId, courseId) {
  const course = await loadCourse(workspaceId, courseId);
  return courseView(course, { modules: outlineOf(course) });
}

async function checkProduct(workspaceId, productId) {
  if (!productId) return;
  await scoped(db.Product, workspaceId, 'Product').findByPkOrThrow(productId);
}

async function createCourse(workspaceId, data, req) {
  await checkProduct(workspaceId, data.productId);
  const course = await db.Course.create({
    workspaceId,
    title: data.title,
    slug: await freeSlug(workspaceId, data.slug || data.title, null),
    description: data.description || null,
    coverUrl: data.coverUrl || null,
    productId: data.productId || null,
    status: 'draft',
  });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'course.create', entityType: 'Course', entityId: course.id, after: courseView(course), req });
  return getCourse(workspaceId, course.id);
}

async function updateCourse(workspaceId, courseId, data, req) {
  const course = await scoped(db.Course, workspaceId, 'Course').findByPkOrThrow(courseId);
  const before = courseView(course);
  const values = { ...data };
  if (values.productId !== undefined) await checkProduct(workspaceId, values.productId);
  if (values.slug !== undefined) values.slug = await freeSlug(workspaceId, values.slug || values.title || course.title, course.id);
  if (values.status === 'published' && (await db.Lesson.count({ where: { courseId } })) === 0) {
    throw new AppError('COURSE_EMPTY', 'Add at least one lesson before publishing the course', 409);
  }
  await course.update(values);
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'course.update', entityType: 'Course', entityId: course.id, before, after: courseView(course), req });
  return getCourse(workspaceId, course.id);
}

async function deleteCourse(workspaceId, courseId, req) {
  const course = await scoped(db.Course, workspaceId, 'Course').findByPkOrThrow(courseId);
  const students = await db.Enrollment.count({ where: { courseId, revokedAt: null } });
  if (students > 0) throw new AppError('COURSE_HAS_STUDENTS', 'Students are enrolled in this course. Unpublish it instead.', 409, { students });
  await course.destroy();
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'course.delete', entityType: 'Course', entityId: courseId, before: courseView(course), req });
}

/**
 * Replaces the whole outline in one save. Modules and lessons that come back
 * with their id are kept (so students' progress stays attached); ones that
 * are gone from the payload are deleted; ones without an id are new.
 */
async function saveOutline(workspaceId, courseId, modules, req) {
  const course = await loadCourse(workspaceId, courseId);
  const fileIds = [...new Set(modules.flatMap((m) => m.lessons.map((l) => l.fileId).filter(Boolean)))];
  if (fileIds.length) {
    const found = await db.DigitalFile.count({ where: { workspaceId, id: fileIds } });
    if (found !== fileIds.length) throw new NotFoundError('File');
  }
  const knownModules = new Map(course.modules.map((m) => [m.id, m]));
  const knownLessons = new Map(course.lessons.map((l) => [l.id, l]));

  await db.sequelize.transaction(async (transaction) => {
    const keptModules = new Set();
    const keptLessons = new Set();
    for (const [mi, m] of modules.entries()) {
      const existing = m.id ? knownModules.get(m.id) : null;
      const moduleRow = existing
        ? await existing.update({ title: m.title, position: mi }, { transaction })
        : await db.CourseModule.create({ courseId, title: m.title, position: mi }, { transaction });
      keptModules.add(moduleRow.id);
      for (const [li, l] of m.lessons.entries()) {
        const values = {
          courseId,
          moduleId: moduleRow.id,
          title: l.title,
          kind: l.kind,
          videoUrl: l.kind === 'video' ? l.videoUrl || null : null,
          body: l.kind === 'text' ? l.body || null : l.body || null,
          fileId: l.kind === 'file' ? l.fileId || null : null,
          durationSeconds: l.durationSeconds || null,
          isFreePreview: Boolean(l.isFreePreview),
          dripDays: l.dripDays || 0,
          position: li,
        };
        const row = l.id && knownLessons.get(l.id) ? await knownLessons.get(l.id).update(values, { transaction }) : await db.Lesson.create(values, { transaction });
        keptLessons.add(row.id);
      }
    }
    const goneLessons = [...knownLessons.keys()].filter((id) => !keptLessons.has(id));
    if (goneLessons.length) await db.Lesson.destroy({ where: { id: goneLessons }, transaction });
    const goneModules = [...knownModules.keys()].filter((id) => !keptModules.has(id));
    if (goneModules.length) await db.CourseModule.destroy({ where: { id: goneModules }, transaction });
    await recordAudit({
      workspaceId,
      actorUserId: req.user.id,
      action: 'course.outline_save',
      entityType: 'Course',
      entityId: courseId,
      metadata: { modules: modules.length, lessons: keptLessons.size, removedLessons: goneLessons.length },
      req,
      transaction,
    });
  });
  return getCourse(workspaceId, courseId);
}

async function listStudents(workspaceId, courseId) {
  await scoped(db.Course, workspaceId, 'Course').findByPkOrThrow(courseId);
  const [enrollments, total] = await Promise.all([
    db.Enrollment.findAll({
      where: { workspaceId, courseId },
      include: [{ model: db.Customer, as: 'customer', attributes: ['id', 'fullName', 'phoneRaw', 'phoneNormalized'] }],
      order: [['enrolledAt', 'DESC']],
      limit: 500,
    }),
    db.Lesson.count({ where: { courseId } }),
  ]);
  const ids = enrollments.map((e) => e.id);
  const done = ids.length
    ? await db.LessonProgress.findAll({
        where: { enrollmentId: ids },
        attributes: ['enrollmentId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
        group: ['enrollmentId'],
        raw: true,
      })
    : [];
  const doneOf = new Map(done.map((r) => [r.enrollmentId, Number(r.n)]));
  return {
    lessonsCount: total,
    students: enrollments.map((e) => ({
      id: e.id,
      customerId: e.customerId,
      name: e.customer ? e.customer.fullName : null,
      phone: e.customer ? e.customer.phoneRaw || e.customer.phoneNormalized : null,
      source: e.source,
      orderId: e.orderId,
      enrolledAt: e.enrolledAt,
      revokedAt: e.revokedAt,
      completedLessons: doneOf.get(e.id) || 0,
    })),
  };
}

async function enroll(workspaceId, courseId, customerId, { orderId = null, source = 'order', transaction } = {}) {
  const [row, created] = await db.Enrollment.findOrCreate({
    where: { courseId, customerId },
    defaults: { workspaceId, courseId, customerId, orderId, source, enrolledAt: new Date() },
    transaction,
  });
  // Buying again after access was taken away gives it back.
  if (!created && row.revokedAt) await row.update({ revokedAt: null }, { transaction });
  return { enrollment: row, created };
}

/** The merchant gives someone access by hand (a gift, a transfer paid outside). */
async function enrollManually(workspaceId, courseId, { phone, fullName }, req) {
  await scoped(db.Course, workspaceId, 'Course').findByPkOrThrow(courseId);
  // eslint-disable-next-line global-require
  const customer = await require('../customers/customerService').findOrCreateByPhone(workspaceId, { phone, fullName });
  const { enrollment } = await enroll(workspaceId, courseId, customer.id, { source: 'manual' });
  await recordAudit({ workspaceId, actorUserId: req.user.id, action: 'course.enroll_manual', entityType: 'Enrollment', entityId: enrollment.id, after: { courseId, customerId: customer.id }, req });
  return listStudents(workspaceId, courseId);
}

async function setEnrollmentRevoked(workspaceId, enrollmentId, revoked, req) {
  const enrollment = await scoped(db.Enrollment, workspaceId, 'Enrollment').findByPkOrThrow(enrollmentId);
  await enrollment.update({ revokedAt: revoked ? new Date() : null });
  await recordAudit({
    workspaceId,
    actorUserId: req.user.id,
    action: revoked ? 'course.enrollment_revoke' : 'course.enrollment_restore',
    entityType: 'Enrollment',
    entityId: enrollment.id,
    req,
  });
  return listStudents(workspaceId, enrollment.courseId);
}

/** After an order is paid: enrolls the buyer in every course sold through a product on the order. Never throws. */
// Started by the order.paid event (jobs.js): retried on failure; an enrolment that exists is not made twice.
async function enrollForOrder(workspaceId, orderId, { rethrow = false } = {}) {
  try {
    const order = await db.Order.findOne({ where: { id: orderId, workspaceId }, include: [{ model: db.OrderItem, as: 'items' }] });
    if (!order) return 0;
    const productIds = [...new Set(order.items.map((i) => i.productId).filter(Boolean))];
    if (productIds.length === 0) return 0;
    const courses = await db.Course.findAll({ where: { workspaceId, productId: productIds }, attributes: ['id'] });
    let made = 0;
    for (const course of courses) {
      const { created } = await enroll(workspaceId, course.id, order.customerId, { orderId: order.id });
      if (created) made += 1;
    }
    return made;
  } catch (err) {
    logger.error(`[courses] enrolling for order ${orderId} failed: ${err.message}`);
    if (rethrow) throw err;
    return 0;
  }
}

// ----------------------------------------------------------------- student --

const portalKey = () => crypto.createHmac('sha256', env.jwt.accessSecret).update('zimos:student-portal').digest();

function signToken(customerId, now = Date.now()) {
  const body = `${customerId}.${now + PORTAL_TTL_MS}`;
  return `${body}.${crypto.createHmac('sha256', portalKey()).update(body).digest('hex')}`;
}

/** The customer id in a live token, or null. */
function readToken(token, now = Date.now()) {
  const [customerId, expires, signature] = String(token || '').split('.');
  if (!customerId || !expires || !/^[0-9a-f]{64}$/.test(signature || '')) return null;
  const expected = crypto.createHmac('sha256', portalKey()).update(`${customerId}.${expires}`).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return null;
  return Number(expires) > now ? customerId : null;
}

async function studentCustomer(workspaceId, phone) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) throw new AppError('INVALID_PHONE', 'A valid phone number is required', 422);
  const customer = await db.Customer.findOne({ where: { workspaceId, phoneNormalized }, attributes: ['id', 'phoneNormalized'] });
  if (!customer) return null;
  const enrolled = await db.Enrollment.count({ where: { workspaceId, customerId: customer.id, revokedAt: null } });
  return enrolled > 0 ? customer : null;
}

/** The answer is the same whether or not the phone has a course. */
async function portalRequestCode(workspaceId, phone) {
  // Before the lookup, so this answer too is the same for every phone.
  if (!require('../otp/verificationCodeService').smsReady()) {
    throw new AppError('SMS_UNAVAILABLE', 'Codes cannot be sent by SMS right now. Try again later.', 503);
  }
  const customer = await studentCustomer(workspaceId, phone);
  if (customer) await otpService.generateAndSendOtp(customer.phoneNormalized, OTP_PURPOSE);
  return { sent: true };
}

async function portalVerify(workspaceId, phone, code) {
  const customer = await studentCustomer(workspaceId, phone);
  if (!customer) throw new AppError('INVALID_CODE', 'That code is not valid', 422);
  await otpService.verifyOtp(customer.phoneNormalized, OTP_PURPOSE, code);
  return { token: signToken(customer.id), expiresInSeconds: PORTAL_TTL_MS / 1000 };
}

async function enrollmentOf(workspaceId, courseId, token) {
  const customerId = readToken(token);
  if (!customerId) return null;
  return db.Enrollment.findOne({ where: { workspaceId, courseId, customerId, revokedAt: null } });
}

const releaseDate = (enrollment, lesson) => new Date(new Date(enrollment.enrolledAt).getTime() + (lesson.dripDays || 0) * 24 * 3600 * 1000);

/** Whether this viewer may open the lesson now, and if not, why. */
function accessTo(lesson, enrollment, now = new Date()) {
  if (lesson.isFreePreview) return { open: true };
  if (!enrollment) return { open: false, reason: 'not_enrolled' };
  const at = releaseDate(enrollment, lesson);
  return at <= now ? { open: true } : { open: false, reason: 'not_released', availableAt: at };
}

/** The student's courses with their progress. */
async function portalCourses(workspaceId, token) {
  const customerId = readToken(token);
  if (!customerId) throw new AuthenticationError('Sign in again', 'STUDENT_SESSION_EXPIRED');
  const enrollments = await db.Enrollment.findAll({
    where: { workspaceId, customerId, revokedAt: null },
    include: [{ model: db.Course, as: 'course', where: { status: 'published' } }],
    order: [['enrolledAt', 'DESC']],
  });
  const out = [];
  for (const e of enrollments) {
    const [total, done] = await Promise.all([db.Lesson.count({ where: { courseId: e.courseId } }), db.LessonProgress.count({ where: { enrollmentId: e.id } })]);
    out.push({ slug: e.course.slug, title: e.course.title, coverUrl: e.course.coverUrl, lessonsCount: total, completedLessons: done, enrolledAt: e.enrolledAt });
  }
  return { courses: out };
}

async function publishedCourse(workspaceId, slug) {
  const course = await db.Course.findOne({ where: { workspaceId, slug: String(slug).toLowerCase(), status: 'published' }, include: TREE() });
  if (!course) throw new NotFoundError('Course');
  return course;
}

/** The course page: its outline, with what this viewer can open. No lesson content. */
async function portalCourse(workspaceId, slug, token) {
  const course = await publishedCourse(workspaceId, slug);
  const enrollment = await enrollmentOf(workspaceId, course.id, token);
  const done = enrollment
    ? new Set((await db.LessonProgress.findAll({ where: { enrollmentId: enrollment.id }, attributes: ['lessonId'], raw: true })).map((r) => r.lessonId))
    : new Set();
  const byId = new Map(course.lessons.map((l) => [l.id, l]));
  const modules = outlineOf(course, { withContent: false }).map((m) => ({
    ...m,
    lessons: m.lessons.map((l) => {
      const access = accessTo(byId.get(l.id), enrollment);
      return { ...l, open: access.open, lockedReason: access.reason || null, availableAt: access.availableAt || null, completed: done.has(l.id) };
    }),
  }));
  let product = null;
  if (!enrollment && course.productId) {
    const p = await db.Product.findOne({ where: { id: course.productId, workspaceId, status: 'active' }, attributes: ['slug'] });
    product = p ? { slug: p.slug } : null;
  }
  return {
    course: { title: course.title, slug: course.slug, description: course.description, coverUrl: course.coverUrl },
    enrolled: Boolean(enrollment),
    // Where to buy it, for a visitor who is not enrolled.
    product,
    modules,
  };
}

async function openLesson(workspaceId, slug, lessonId, token) {
  const course = await publishedCourse(workspaceId, slug);
  const lesson = course.lessons.find((l) => l.id === lessonId);
  if (!lesson) throw new NotFoundError('Lesson');
  const enrollment = await enrollmentOf(workspaceId, course.id, token);
  const access = accessTo(lesson, enrollment);
  if (!access.open) {
    if (access.reason === 'not_released') throw new AppError('LESSON_NOT_RELEASED', 'This lesson is not available yet', 403, { availableAt: access.availableAt });
    throw new AppError('LESSON_LOCKED', 'Buy the course to open this lesson', 403);
  }
  return { course, lesson, enrollment };
}

async function portalLesson(workspaceId, slug, lessonId, token) {
  const { lesson } = await openLesson(workspaceId, slug, lessonId, token);
  return {
    lesson: {
      id: lesson.id,
      title: lesson.title,
      kind: lesson.kind,
      durationSeconds: lesson.durationSeconds,
      videoUrl: lesson.kind === 'video' ? lesson.videoUrl : null,
      body: lesson.body,
      fileName: lesson.kind === 'file' && lesson.file ? lesson.file.name : null,
    },
  };
}

async function portalLessonFile(workspaceId, slug, lessonId, token) {
  const { lesson } = await openLesson(workspaceId, slug, lessonId, token);
  if (lesson.kind !== 'file' || !lesson.fileId) throw new NotFoundError('File');
  const file = await db.DigitalFile.findOne({ where: { id: lesson.fileId, workspaceId } });
  const stored = file ? await getStorage().getPrivate(file.storageKey) : null;
  if (!stored) throw new NotFoundError('File');
  return { buffer: stored.buffer, name: file.name, mimeType: file.mimeType };
}

async function portalComplete(workspaceId, slug, lessonId, token, completed) {
  const { lesson, enrollment } = await openLesson(workspaceId, slug, lessonId, token);
  if (!enrollment) throw new AuthenticationError('Sign in to save your progress', 'STUDENT_SESSION_EXPIRED');
  if (completed) await db.LessonProgress.findOrCreate({ where: { enrollmentId: enrollment.id, lessonId: lesson.id } });
  else await db.LessonProgress.destroy({ where: { enrollmentId: enrollment.id, lessonId: lesson.id } });
  return { completed: Boolean(completed) };
}

module.exports = {
  listCourses,
  getCourse,
  createCourse,
  updateCourse,
  deleteCourse,
  saveOutline,
  listStudents,
  enrollManually,
  setEnrollmentRevoked,
  enrollForOrder,
  portalRequestCode,
  portalVerify,
  portalCourses,
  portalCourse,
  portalLesson,
  portalLessonFile,
  portalComplete,
};
