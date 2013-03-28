var _ = require('underscore')
  , bcrypt = require('bcrypt')
  , Schema = require('mongoose').Schema
  , config = require('./config')
  , logging = require('./logging')
  , mongoose = require('mongoose')
  , passport = require('passport')
  ;

var User;

var WebhookConfig = new Schema({
    url: String
  , title: String
  , secret: String
  , type: {type: String, default: "test"}
});

var CollaboratorConfig = new Schema({
    user_id : { type: Schema.ObjectId, ref: 'user' }
  , type: { type: String }
  // access levels: 0 = read-only, 1 = admin
  , access_level: { type: Number }
});

var GithubSchema = {
        id: Number
      , login: String
      , accessToken: String
      , gravatarId: String
      , name: String
      , email: String
      , publicRepoCount: Number
      , publicGistCount: Number
      , followingCount: Number
      , followersCount: Number
      , company: String
      , blog: String
      , location: String
      , permission: String
      , createdAt: Date

      // Private data
      , totalPrivateRepoCount: Number
      , collaborators: Number
      , diskUsage: Number
      , ownedPrivateRepoCount: Number
      , privateGistCount: Number
      , plan: {
            name: String
          , collaborators: Number
          , space: Number
          , privateRepos: Number
        }
}


var RepoConfig = new Schema({
    pubkey: {type: String }
  , privkey: {type: String }
  , secret: {type: String }
  , url: {type: String, sparse: true}
  , display_url: String
  , active: { type: Boolean, default: true }
  // Provider e.g. heroku, dotcloud
  , prod_deploy_target: {
        provider: String
      , account_id: String
      // Automatically deploy to this provider if the tests pass and this is a TEST_AND_DEPLOY job
      , deploy_on_green: { type: Boolean, default: true }
    }
  , webhooks: [WebhookConfig]
  // E.g. language Python, framework Pyramid
  , project_type: {
        language: String
      , framework: String
    }
  , collaborators:[CollaboratorConfig]
});

RepoConfig.virtual('has_prod_deploy_target').get(function() {
  return (this.prod_deploy_target !== undefined &&
    this.prod_deploy_target.provider !== undefined &&
    this.prod_deploy_target.account_id !== undefined);
});

var HerokuConfig = new Schema({
    api_key: {type: String}
  , pubkey: {type: String}
  , privkey: {type: String}
  // with Heroku, we identify deploy targets by their user@host in pubkey.
  // for convenience, we store this as a separate property - account_id
  , account_id: String
  // Currently, Heroku deploy targets are tied to a specific app object.
  , app: String
});

var DotCloudConfig = new Schema({
  // with dotCloud, we identify deploy targets by the account username.
  // Currently, we only support linking a single dotCloud account to a Strider account,
  // but this might change one day.
  // for convenience, we store this as a separate property - account_id
    account_id: String
  // Currently, dotCloud deploy targets are tied to a specific app object.
  , app: String
});

var JobSchema = new Schema({
    _owner : { type: Schema.ObjectId, ref: 'user' }
  , deploy_exitcode : Number
    // created_timestamp is indexed for metrics purposes
  , created_timestamp : { type: Date, index: true }
    // most job read queries sort by finished_timestamp
  , finished_timestamp : { type: Date, index: true, sparse:true}
  , github_commit_info : {
        id : String,
        author : {
          email: String,
          name: String,
          username: String
        },
        timestamp: String,
        message: String
    }
    // We index this to speed archival of deleted repositories.
  , repo_url : {type: String, index: true}
  , stderr : String
  , stdout : String
  , stdmerged : String
  , test_exitcode : Number
  , type : String
  , archived_timestamp: { type: Date }
});

var Job = mongoose.model('Job', JobSchema);


var InviteCodeSchema = new Schema({
    code: { type: String, unique: true }
  , created_timestamp: Date
  , consumed_timestamp: Date
  , emailed_to: { type: String, index: true }
  , consumed_by_user: { type: Schema.ObjectId, ref: 'user' }
  , collaborations: [
        {
           repo_url: String
         , access_level: Number
         , invited_by: { type: Schema.ObjectId, ref: 'user' }
        }
    ]
});

var InviteCode = mongoose.model('InviteCode', InviteCodeSchema);


// Features default to being on! See feature.js
var FeatureSchema = new Schema({
    name: { type: String, unique: true }
  // If true, feature enabled for all admin users
  , admin_enabled: { type: Boolean, default: false }
  // List of ObjectID's for users of which feature is enabled
  // if we have a lot of feature documents, we should index this.
  , users_enabled: [{type: Schema.ObjectId, ref: 'user', default: []}]
});

var Feature = mongoose.model('Feature', FeatureSchema);


var UserSchema = new Schema({
    github_metadata: {}
  , github_config: [RepoConfig]
  , github: GithubSchema
  , jobs: [{type: Schema.ObjectId, ref: 'Job'}]
  , heroku: [HerokuConfig]
  , dotcloud_config: [DotCloudConfig]
  , account_level: Number
  // dotcloud_refresh_lock is used in dotcloud.js to force serial token refreshes.
  , dotcloud_refresh_lock: Number
  , salt: { type: String, required: true }
  , hash: { type: String, required: true }
  , email: { type: String, required: true }
});


/*
 * get_repo_config()
 *
 * Return the config sub-object matching the url.
 * Match is case-insensitive!
 *
 * <case_insensitive_url> - URL to match on.
 * <cb> - function of signature function(err, repo_config, access_level, user_obj).
 *
 * access levels: 0 = read-only, 1 = admin
 */
UserSchema.methods.get_repo_config = function(case_insensitive_url, cb) {
  if (!cb) {
    throw new Error("No callback supplied");
  }
    // If the repo is found in the current user, it means we have admin privileges
  var repo = _.find(this.github_config, function(repo_config) {
    return case_insensitive_url.toLowerCase() == repo_config.url;
  });
  if (repo) {
    return cb(null, repo, 1, this);
  }
  var self = this;
  console.debug("user.get_repo_config() - no repos found matching %s in %j, querying DB",
    case_insensitive_url, this.github_config);
    // Look for user object with the project url configured AND current user id is in collaborators list.
    User.findOne({
        "github_config.url":case_insensitive_url.toLowerCase(),
        "github_config.collaborators.user_id": self._id
      }, function(err, user_obj) {
      if (err || !user_obj) {
        console.debug("user.get_repo_config() - did not find a repo matching %s for any user",
          case_insensitive_url);
        return cb("no repo found", null);
      }
      var repo = _.find(user_obj.github_config, function(repo_config) {
        return case_insensitive_url.toLowerCase() == repo_config.url;
      });
      if (!repo) {
        console.error(
          "user.get_repo_config() - Error finding matching github_config despite DB query success!");
        return cb("no repo found", null);
      }
      return cb(null, repo,
        _.find(repo.collaborators, function(c) { return c.user_id.toString() === self._id.toString();}).access_level,
        user_obj);
  });
};

/*
 * get_repo_config_list()
 *
 * Return the list of repo config objects which the user has access to.
 *
 * <cb> - function of signature function(err, repo_config_list)
 * <access_level> - level of access to request. 0 = all, 1 = admin. Default: all (optional)
 */
UserSchema.methods.get_repo_config_list = function(cb, access_level) {

  var access_level = access_level || 0;

  if (!cb) {
    throw new Error("No callback supplied");
  }

  var repo_list = this.github_config;
  // Look for any additional configured repositories for which we are listed as access_level;
  var self = this;
  User.find({
    // Ignore our own user object.
    "_id":{$ne:self._id},
    // Our user ID is in the collaborators list.
    "github_config.collaborators.user_id":self._id,
  }, function(err, results) {
      if (err) {
        throw err;
      }
      // We filter here by access level, don't bother doing it in the DB
      var non_user_repos = [];
      _.each(results, function(user_obj) {
        // For each user document, filter those on which we are a collaborator.
        non_user_repos = non_user_repos.concat(_.filter(user_obj.github_config, function(config) {
          var collab = _.find(config.collaborators, function(c) {
            return c.user_id.toString() === self._id.toString();
          });
          if (collab) {
            return (collab.user_id.toString() === self._id.toString() && collab.access_level >= access_level);
          }
          return false;
        }));
      });
      return cb(null, repo_list.concat(non_user_repos));
  });

};

/*
 * get_repo_metadata()
 *
 * Return the metadata sub-object matching the Github repository ID.
 * Defaults to assuming it is for the github id linked to the account via OAuth2.
 *
 * <repo_id> - Github repository Id
 * <gh_user_id> - Optional Github user ID if not that of the user linked to the account.
 */
UserSchema.methods.get_repo_metadata = function(repo_id, ghuid) {
  var gh_user_id = ghuid || this.github.id;
  var repo = _.find(this.github_metadata[gh_user_id].repos, function(repo) {
    return repo_id == repo.id;
  });
  return repo;
};

/*
 * get_prod_deploy_target()
 *
 * Return the deploy target sub-object matching the url.
 * Match is case-insensitive!
 *
 * <case_insensitive_url> - URL to match on.
 * <cb> - function of signature function(err, deploy_target).
 */
UserSchema.methods.get_prod_deploy_target = function(case_insensitive_url,
    cb) {
    var self = this;
    this.get_repo_config(case_insensitive_url, function(err, repo) {
      var deploy_target;
      if (repo.has_prod_deploy_target) {
        // XXX assumes heroku for now
        deploy_target = _.find(self.heroku, function(heroku) {
          return heroku.account_id === repo.prod_deploy_target.account_id;
        });
        return cb(null, deploy_target);
      }
      cb("No deploy target found", null);
    });
};


UserSchema.virtual('password')
.get(function () {
  return this._password;
})
.set(function (password) {
  this._password = password;
  var salt = this.salt = bcrypt.genSaltSync(10);
  this.hash = bcrypt.hashSync(password, salt);
});

UserSchema.method('verifyPassword', function(password, callback) {
  bcrypt.compare(password, this.get('hash'), callback);
});

UserSchema.static('authenticate', function(email, password, callback) {
  this.findOne({ email: email }, function(err, user) {
    if (err) { return callback(err); }
    if (!user) { return callback("No User", false); }

    user.verifyPassword(password, function(err, passwordCorrect) {
      if (err) { return callback(err); }
      if (!passwordCorrect) { return callback("Incorrect PWD", false); }
      return callback(null, user);
    });
  });
})

UserSchema.static('findByGithub', function(ghProfileId, cb){
  this.findOne({"github_config.collaborators.user_id": ghProfileId}, cb);
})

UserSchema.static('registerWithInvite', function(inviteCode, email, password, cb){
  // Check Invite Code
  InviteCode.findOne({code:inviteCode, consumed_timestamp:null}, function(err, invite){

    if (err || !invite ){
      return cb("Invalid Invite");
    }

    // Create User
    var u = new User();
    u.email = email;
    u.set('password', password);
    u.save(function(e, user){
      if (e)
        return cb("Error Creating User:" + e);
        
      // For each collaboration in the invite, add permissions to the repo_config
      if (invite != null && invite.collaborations !== undefined && invite.collaborations.length > 0) {
        _.each(invite.collaborations, function(c) {
          User.update(
            {"github_config.url":c.repo_url},
            {
              $push:{
                "github_config.$.collaborators":{
                  type: c.type,
                  user_id: user._id,
                  access_level: c.access_level
                }
              }
          }, function(err) {
            if (err) {
              console.debug("User regstration - failure applying collaborators from invite: %s", err);
            }
          })
        })
      }

      // Mark Invite Code as used.
      InviteCode.update(
          {code:inviteCode}
        , {"$set": {consumed_timestamp:new Date(), consumed_by_user:user._id}}
        , {}
        , function(err, num) {
          if (err)
            return cb("Error updating invite code, user was created: " + err)
          else 
            return cb(null, user);
        }
      ) 
    })
  })
})


var InviteCode = mongoose.model('InviteCode', InviteCodeSchema);

User = mongoose.model('user', UserSchema);
var Job = mongoose.model('Job', JobSchema);
var Feature = mongoose.model('Feature', FeatureSchema);

module.exports = {
  Feature: Feature,
  InviteCode: InviteCode,
  Job: Job,
  User: User,
  UserSchema: UserSchema,
  RepoConfig: RepoConfig,
  HerokuConfig: HerokuConfig,
};