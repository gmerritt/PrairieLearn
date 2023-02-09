var ERR = require('async-stacktrace');
var express = require('express');
var router = express.Router();

const { checkPasswordOrRedirect } = require('../../middlewares/studentAssessmentAccess');
var error = require('../../prairielib/lib/error');
var assessment = require('../../lib/assessment');
var sqldb = require('@prairielearn/postgres');

var sql = sqldb.loadSqlEquiv(__filename);
var groupAssessmentHelper = require('../../lib/groups');

router.get('/', async function (req, res, next) {
  if (res.locals.assessment.type !== 'Exam') return next();
  var params = {
    assessment_id: res.locals.assessment.id,
    user_id: res.locals.user.user_id,
  };
  if (res.locals.assessment.multiple_instance) {
    // The user has landed on this page to create a new assessment instance.
    //
    // Before allowing the user to create a new assessment instance, we need
    // to check if the current access rules require a password. If they do,
    // we'll ensure that the password has already been entered before allowing
    // students to create and start a new assessment instance.
    if (!checkPasswordOrRedirect(req, res)) return;
    if (res.locals.assessment.group_work) {
      const groupInfo = await groupAssessmentHelper.getGroupInfo(
        res.locals.assessment.id,
        res.locals.user.user_id
      );
      res.locals.permissions = groupInfo.permissions;
      res.locals.minSize = groupInfo.minSize;
      res.locals.maxSize = groupInfo.maxSize;
      res.locals.groupSize = groupInfo.groupSize;
      res.locals.needsize = groupInfo.needsize;
      res.locals.hasRoles = groupInfo.hasRoles;
      res.locals.groupMembers = groupInfo.groupMembers;
      res.locals.joinCode = groupInfo.joinCode;
      res.locals.minimumSizeMet = groupInfo.minimumSizeMet;
      res.locals.start = groupInfo.start;
      res.locals.used_join_code = groupInfo.usedJoinCode;
      res.locals.validationErrors = groupInfo.validationErrors;
      res.locals.disabledRoles = groupInfo.disabledRoles;
      res.locals.group_roles = groupInfo.groupRoles;
      res.locals.rolesAreBalanced = groupInfo.rolesAreBalanced;

      if (groupInfo.hasRoles) {
        if (groupInfo.isGroupMember) {
          const permissions = await groupAssessmentHelper.getAssessmentLevelPermissions(
            res.locals.assessment.id,
            res.locals.user.user_id
          );
          res.locals.can_view_role_table = permissions.can_assign_roles_at_start;
          res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
        } else {
          res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
        }
      } else {
        res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
      }
    } else {
      res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
    }
  } else {
    const result = await sqldb.queryAsync(sql.select_single_assessment_instance, params);
    if (result.rowCount === 0) {
      // Before allowing the user to create a new assessment instance, we need
      // to check if the current access rules require a password. If they do,
      // we'll ensure that the password has already been entered before allowing
      // students to create and start a new assessment instance.
      if (!checkPasswordOrRedirect(req, res)) return;
      if (res.locals.assessment.group_work) {
        const groupInfo = await groupAssessmentHelper.getGroupInfo(
          res.locals.assessment.id,
          res.locals.user.user_id
        );
        res.locals.permissions = groupInfo.permissions;
        res.locals.minSize = groupInfo.minSize;
        res.locals.groupSize = groupInfo.groupSize;
        res.locals.maxSize = groupInfo.maxSize;
        res.locals.groupSize = groupInfo.groupSize;
        res.locals.hasRoles = groupInfo.hasRoles;
        res.locals.groupMembers = groupInfo.groupMembers;
        res.locals.joinCode = groupInfo.joinCode;
        res.locals.start = groupInfo.start;
        res.locals.usedJoinCode = groupInfo.usedJoinCode;

        if (groupInfo.hasRoles) {
          if (groupInfo.isGroupMember) {
            res.locals.rolesInfo = groupInfo.rolesInfo;
            res.locals.validationErrors = groupInfo.rolesInfo.validationErrors;
            res.locals.disabledRoles = groupInfo.rolesInfo.disabledRoles;
            res.locals.group_roles = groupInfo.rolesInfo.groupRoles;
            res.locals.rolesAreBalanced = groupInfo.rolesInfo.rolesAreBalanced;
            const permissions = await groupAssessmentHelper.getAssessmentLevelPermissions(
              res.locals.assessment.id,
              res.locals.user.user_id
            );
            res.locals.can_view_role_table = permissions.can_assign_roles_at_start;
          }
        }
      }
      res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
    } else {
      res.redirect(res.locals.urlPrefix + '/assessment_instance/' + result.rows[0].id);
    }
  }
});

router.post('/', function (req, res, next) {
  if (res.locals.assessment.type !== 'Exam') return next();

  // No, you do not need to verify authz_result.authorized_edit (indeed, this flag exists
  // only for an assessment instance, not an assessment).
  //
  // The assessment that is created here will be owned by the effective user. The only
  // reason to worry, therefore, is if the effective user has a different UID than the
  // authn user. This is only allowed, however, if the authn user has permission to edit
  // student data in the course instance (which has already been checked), exactly the
  // permission required to create an assessment for the effective user.

  if (req.body.__action === 'new_instance') {
    // Before allowing the user to create a new assessment instance, we need
    // to check if the current access rules require a password. If they do,
    // we'll ensure that the password has already been entered before allowing
    // students to create and start a new assessment instance.
    if (!checkPasswordOrRedirect(req, res)) return;

    assessment.makeAssessmentInstance(
      res.locals.assessment.id,
      res.locals.user.user_id,
      res.locals.assessment.group_work,
      res.locals.authn_user.user_id,
      res.locals.authz_data.mode,
      res.locals.authz_result.time_limit_min,
      res.locals.req_date,
      (err, assessment_instance_id) => {
        if (ERR(err, next)) return;
        res.redirect(res.locals.urlPrefix + '/assessment_instance/' + assessment_instance_id);
      }
    );
  } else if (req.body.__action === 'join_group') {
    groupAssessmentHelper.joinGroup(
      req.body.join_code,
      res.locals.assessment.id,
      res.locals.user.user_id,
      res.locals.authn_user.user_id,
      function (err, succeeded, permissions) {
        if (ERR(err, next)) return err;
        if (succeeded) {
          res.redirect(req.originalUrl);
        } else {
          res.locals.permissions = permissions;
          res.locals.groupsize = 0;
          res.locals.used_join_code = req.body.join_code;
          res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
        }
      }
    );
  } else if (req.body.__action === 'create_group') {
    groupAssessmentHelper.createGroup(
      req.body.groupName,
      res.locals.assessment.id,
      res.locals.user.user_id,
      res.locals.authn_user.user_id,
      function (err, succeeded, uniqueGroupName, invalidGroupName, permissions) {
        if (ERR(err, next)) return;
        if (succeeded) {
          res.redirect(req.originalUrl);
        } else {
          if (invalidGroupName) {
            res.locals.invalidGroupName = true;
          } else {
            res.locals.uniqueGroupName = uniqueGroupName;
          }
          res.locals.permissions = permissions;
          res.locals.groupsize = 0;
          res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
        }
      }
    );
  } else if (req.body.__action === 'update_group_roles') {
    groupAssessmentHelper.updateGroupRoles(
      req.body,
      res.locals.assessment.id,
      res.locals.user.user_id,
      res.locals.authn_user.user_id,
      function (err) {
        if (ERR(err, next)) return;
        res.redirect(req.originalUrl);
      }
    );
  } else if (req.body.__action === 'leave_group') {
    groupAssessmentHelper.leaveGroup(
      res.locals.assessment.id,
      res.locals.user.user_id,
      res.locals.authn_user.user_id,
      function (err) {
        if (ERR(err, next)) return;
        res.redirect(req.originalUrl);
      }
    );
  } else {
    return next(
      error.make(400, 'unknown __action', {
        locals: res.locals,
        body: req.body,
      })
    );
  }
});

module.exports = router;
