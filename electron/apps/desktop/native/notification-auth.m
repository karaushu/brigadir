#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <node_api.h>

// spec/notifications-slack-notes-and-schedules#macos-permission: Electron does not report the notification authorization; this addon reads and requests it
// for the app's own bundle. It runs inside the main process: a helper binary would have another identity.
static const char *statusName(UNAuthorizationStatus status) {
  switch (status) {
    case UNAuthorizationStatusAuthorized: case UNAuthorizationStatusProvisional: return "granted";
    case UNAuthorizationStatusDenied: return "denied";
    case UNAuthorizationStatusNotDetermined: return "not-determined";
    default: return "unknown";
  }
}
static void resolve(napi_env env, napi_value callback, void *context, void *data) {
  (void)callback;
  if (!env) return;
  napi_value value;
  napi_create_string_utf8(env, (const char *)data, NAPI_AUTO_LENGTH, &value);
  napi_resolve_deferred(env, (napi_deferred)context, value);
}
static napi_value start(napi_env env, BOOL request) {
  napi_deferred deferred; napi_value promise, name;
  napi_create_promise(env, &deferred, &promise);
  if (!NSBundle.mainBundle.bundleIdentifier) {
    napi_create_string_utf8(env, "unknown", NAPI_AUTO_LENGTH, &name);
    napi_resolve_deferred(env, deferred, name);
    return promise;
  }
  napi_threadsafe_function done;
  napi_create_string_utf8(env, "notification-auth", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, NULL, NULL, name, 0, 1, NULL, NULL, deferred, resolve, &done) != napi_ok) {
    napi_create_string_utf8(env, "unknown", NAPI_AUTO_LENGTH, &name);
    napi_resolve_deferred(env, deferred, name);
    return promise;
  }
  UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
  void (^read)(void) = ^{
    [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
      napi_call_threadsafe_function(done, (void *)statusName(settings.authorizationStatus), napi_tsfn_blocking);
      napi_release_threadsafe_function(done, napi_tsfn_release);
    }];
  };
  if (request) [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionBadge | UNAuthorizationOptionSound) completionHandler:^(BOOL granted, NSError *error) { (void)granted; (void)error; read(); }];
  else read();
  return promise;
}
static napi_value status(napi_env env, napi_callback_info info) { (void)info; return start(env, NO); }
static napi_value request(napi_env env, napi_callback_info info) { (void)info; return start(env, YES); }
NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "status", NAPI_AUTO_LENGTH, status, NULL, &fn); napi_set_named_property(env, exports, "status", fn);
  napi_create_function(env, "request", NAPI_AUTO_LENGTH, request, NULL, &fn); napi_set_named_property(env, exports, "request", fn);
  return exports;
}
