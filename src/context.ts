import ko from 'knockout'
import Route from './Route'                               // eslint-disable-line
import Router, { Middleware } from './router'             // eslint-disable-line
import {
  AsyncCallback,                                          // eslint-disable-line
  isGenerator, isThenable, isUndefined,
  concat,
  extend,
  map,
  promisify,
  sequence,
  traversePath
} from './utils'

export default class Context {
  /* eslint-disable */
  _redirect: string
  router: Router
  route: Route
  params: { [k: string]: any }
  // path including childPath
  path: string
  // path segment relevant to this context
  pathname: string
  // full path w/ base
  fullPath: string
  // full path w/o base
  canonicalPath: string

  private _queue:                      Array<Promise<any>>  = []
  private _beforeNavigateCallbacks:    Array<AsyncCallback> = []
  private _appMiddlewareDownstream:    Array<AsyncCallback> = []
  private _routeMiddlewareDownstream:  Array<AsyncCallback> = []
  /* eslint-enable */

  constructor(router: Router, path: string, _with: { [key: string]: any } = {}) {
    const route = router.resolveRoute(path)
    const [params, pathname, childPath] = route.parse(path)

    extend(this, {
      router,
      route,
      params,
      path,
      pathname
    }, _with)

    this.router.ctx = this
    this.fullPath = this.router.base + this.pathname
    this.canonicalPath = this.fullPath.replace(new RegExp(Router.head.base, 'i'), '')

    if (childPath) {
      this.router.$child = new Router(childPath, this.router, this)
    } else {
      Router.tail = router
    }
  }

  addBeforeNavigateCallback(cb) {
    this._beforeNavigateCallbacks.unshift(cb)
  }

  get $root() {
    return this.router.$root.ctx
  }

  get $parent() {
    return isUndefined(this.router.$parent) ? undefined : this.router.$parent.ctx
  }

  get $child() {
    return isUndefined(this.router.$child) ? undefined : this.router.$child.ctx
  }

  get $parents(): Array<Context> {
    return map(this.router.$parents, (r) => r.ctx)
  }

  get $children(): Array<Context> {
    return map(this.router.$children, (r) => r.ctx)
  }

  queue(promise) {
    this._queue.push(promise)
  }

  redirect(path) {
    this._redirect = path
  }

  async runBeforeNavigateCallbacks(): Promise<boolean> {
    let ctx: Context = this                               // eslint-disable-line
    let callbacks = []
    while (ctx) {
      callbacks = [...ctx._beforeNavigateCallbacks, ...callbacks]
      ctx = ctx.$child
    }
    const { success } = await sequence(callbacks)
    return success
  }

  private async flushQueue() {
    const thisQueue = Promise.all(this._queue).then(() => {
      this._queue = []
    })
    const childQueues = map(this.$children, (c) => c.flushQueue())
    await Promise.all<Promise<void>>([thisQueue, ...childQueues])
  }

  render() {
    let ctx: Context = this                               // eslint-disable-line

    while (ctx) {
      if (isUndefined(ctx._redirect)) {
        ctx.router.component(ctx.route.component)
      }
      ctx = ctx.$child
    }
    ko.tasks.runEarly()
  }

  async runBeforeRender(flush = true) {
    const appMiddlewareDownstream = Context.runMiddleware(Router.middleware, this)
    const routeMiddlewareDownstream = Context.runMiddleware(this.route.middleware, this)

    const { count: numAppMiddlewareRanPreRedirect } = await sequence(appMiddlewareDownstream)
    const { count: numRouteMiddlewareRanPreRedirect } = await sequence(routeMiddlewareDownstream)

    this._appMiddlewareDownstream = appMiddlewareDownstream.slice(0, numAppMiddlewareRanPreRedirect)
    this._routeMiddlewareDownstream = routeMiddlewareDownstream.slice(0, numRouteMiddlewareRanPreRedirect)

    if (this.$child) {
      await this.$child.runBeforeRender(false)
    }
    if (flush) {
      await this.flushQueue()
    }
  }

  async runAfterRender(flush = true) {
    await sequence(concat(this._appMiddlewareDownstream, this._routeMiddlewareDownstream))
    if (this.$child) {
      await this.$child.runAfterRender(false)
    }
    if (flush) {
      await this.flushQueue()
    }
    if (this._redirect) {
      const { router, path } = traversePath(this.router, this._redirect)
      router.update(path)
    }
  }

  async runBeforeDispose(flush = true) {
    if (this.$child) {
      await this.$child.runBeforeDispose(false)
    }
    await sequence(concat(this._routeMiddlewareDownstream, this._appMiddlewareDownstream))
    if (flush) {
      await this.flushQueue()
    }
  }

  async runAfterDispose(flush = true) {
    if (this.$child) {
      await this.$child.runAfterDispose(false)
    }
    await sequence(concat(this._routeMiddlewareDownstream, this._appMiddlewareDownstream))
    if (flush) {
      await this.flushQueue()
    }
  }

  private static runMiddleware(middleware: Middleware[], ctx: Context): Array<AsyncCallback> {
    return map(middleware, (fn) => {
      const runner = Context.generatorify(fn)(ctx)
      let beforeRender = true
      return async () => {
        const ret = runner.next() || {}
        if (isThenable(ret)) {
          await ret
        } else if (isThenable(ret.value)) {
          await ret.value
        }
        if (beforeRender) {
          // this should only block the sequence for the first call,
          // and allow cleanup after the redirect
          beforeRender = false
          return isUndefined(ctx._redirect)
        } else {
          return true
        }
      }
    })
  }

  // ts why u no haz async generators?? babel why ur generators so $$$?????
  private static generatorify(fn) {
    return isGenerator(fn)
      ? fn
      : function(ctx) {
        let count = 1, ret
        return {
          async next() {
            switch (count++) {
            case 1:
              ret = await promisify(fn)(ctx) || false
              return ret && ret.beforeRender
                    ? await promisify(ret.beforeRender)()
                    : ret
            case 2: return ret && await promisify(ret.afterRender)()
            case 3: return ret && await promisify(ret.beforeDispose)()
            case 4: return ret && await promisify(ret.afterDispose)()
            }
          },
        }
      }
  }

  // function generatorify(fn) {
  //   return isGenerator(fn)
  //     ? fn
  //     : async function * (...args) {
  //         const ret = await promisify(fn)(...args)
  //
  //         if (isPlainObject(ret)) {
  //           yield await promisify(ret.beforeRender)()
  //           yield await promisify(ret.afterRender)()
  //           yield await promisify(ret.beforeDispose)()
  //           yield await promisify(ret.afterDispose)()
  //         } else {
  //           yield ret
  //         }
  //       }
  // }
  }
