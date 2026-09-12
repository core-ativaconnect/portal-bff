export function isDeskRoute(route) {
  return route.controller === 'AuthController' && ['login', 'currentUser'].includes(route.operation)
    || route.controller === 'PlatformController' && ['listContracts', 'getContract'].includes(route.operation)
    || route.controller === 'PlatformHelpDeskController' && (route.method === 'GET' || ['assign', 'release', 'transfer', 'sendMessage', 'close'].includes(route.operation));
}
