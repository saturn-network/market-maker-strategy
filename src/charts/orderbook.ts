import _ from 'lodash'
import chalk from 'chalk'
import { BigNumber } from 'bignumber.js'

export class OrderBookPrinter {
  orderbook: any

  constructor(orderbook: object) {
    this.orderbook = orderbook
  }

  public print() {
    console.log(chalk.yellow(`Order Book snapshot at ${new Date()}`))
    let chartist = new OrderBookChart(this.orderbook.buys, this.orderbook.sells)
    console.log(chartist.plot())
  }
}

class OrderBookChart {
  buys: Array<object>
  sells: Array<object>
  buyDepth: BigNumber
  sellDepth: BigNumber
  truncated: boolean = false

  constructor(buys: Array<object>, sells: Array<object>) {
    // buys & sells are very confusing, bug hang on a second
    // Every trade has two counterparties, a buyer and a seller
    // Technically speaking, in case of an exchange it is a maker and a taker
    // Saturn API creates namings from the taker's perspectives
    // as that is what we want to display in most UIs
    // Since this is a maker bot, we have to flip buys and sells

    // We sort all orders by price, from lowest to highest
    // And we also filter sell outliers: orders that are selling
    // tokens and outlier unrealistic prices, as those skew
    // the overall numbers quite a bit
    this.buys = sells.sort((a: any, b: any) => {
      let aprice = new BigNumber(a.price)
      let bprice = new BigNumber(b.price)
      return aprice.minus(bprice).toNumber()
    })
    this.buyDepth = _.reduce(_.map(sells, (order: any) => {
      return this.etherBalance(order)
    }), (x, y) => x.plus(y), new BigNumber(0))

    buys = this.filterSellOrders(buys)
    this.sells = buys.sort((a: any, b: any) => {
      let aprice = new BigNumber(a.price)
      let bprice = new BigNumber(b.price)
      return aprice.minus(bprice).toNumber()
    })

    this.sellDepth = _.reduce(_.map(buys, (order: any) => {
      return this.etherBalance(order)
    }), (x, y) => x.plus(y), new BigNumber(0))
  }

  public plot = () => {
    let min = new BigNumber(0)
    let max = this.buyDepth.gt(this.sellDepth) ? this.buyDepth : this.sellDepth

    let range   = max
    let offset  = 3
    let padding = '           '
    let height  = 8
    let ratio   = new BigNumber(height).dividedBy(range)
    let min2    = Math.round(min.times(ratio).toNumber())
    let max2    = Math.round(max.times(ratio).toNumber())
    let rows    = Math.abs(max2 - min2)
    let width   = this.buys.length + this.sells.length + offset
    let format  = (x: number) => (padding + x.toFixed (2)).slice(-padding.length)

    // first, clean the canvas
    let result = new Array(rows + 1)
    for (let i = 0; i <= rows; i++) {
      result[i] = new Array(width)
      for (let j = 0; j < width; j++) {
        result[i][j] = ' '
      }
    }

    // then, draw axis and labels
    for (let y = min2; y <= max2; y++) {
      let label = format(max.toNumber() - (y - min2) * range.toNumber() / rows)
      result[y - min2][Math.max(offset - label.length, 0)] = label
      result[y - min2][offset - 1] = '┤'
    }

    // Set the first value
    let y0 = Math.round(this.buyDepthAtIndex(0).times(ratio).toNumber()) - min2
    result[rows - y0][offset - 1] = chalk.green('┼')

    // Set all the rest of the buys
    for (let x = 0; x < this.buys.length - 1; x++) {
      let y0 = Math.round(this.buyDepthAtIndex(x + 0).times(ratio).toNumber()) - min2
      let y1 = Math.round(this.buyDepthAtIndex(x + 1).times(ratio).toNumber()) - min2
      if (y0 == y1) {
        result[rows - y0][x + offset] = chalk.green('─')
      } else {
        result[rows - y1][x + offset] = chalk.green((y0 > y1) ? '╰' : '╭')
        result[rows - y0][x + offset] = chalk.green((y0 > y1) ? '╮' : '╯')
        let from = Math.min(y0, y1)
        let to = Math.max(y0, y1)
        for (let y = from + 1; y < to; y++) {
          result[rows - y][x + offset] = chalk.green('│')
        }
      }
    }

    // Now set the values for the sells
    // Again, special handling for first element, and then a loop for the rest
    // of the orders
    let from = Math.round(this.sellDepthAtIndex(0).times(ratio).toNumber()) - min2
    let to = Math.round(this.sellDepthAtIndex(1).times(ratio).toNumber()) - min2
    if (to != from) {
      let to = Math.round(this.sellDepthAtIndex(1).times(ratio).toNumber()) - min2
      result[rows][this.buys.length + offset - 1] = chalk.red('╯')
      result[rows - to][this.buys.length + offset - 1] = chalk.red('╭')
      for (let y = 1; y < to; y++) {
        result[rows - y][this.buys.length + offset - 1] = chalk.red('│')
      }
    } else {
      result[rows][this.buys.length + offset - 1] = chalk.red('─')
    }
    for (let x = 1; x < this.sells.length - 1; x++) {
      let y0 = Math.round(this.sellDepthAtIndex(x + 0).times(ratio).toNumber()) - min2
      let y1 = Math.round(this.sellDepthAtIndex(x + 1).times(ratio).toNumber()) - min2
      if (y0 == y1) {
        result[rows - y0][x + offset + this.buys.length - 1] = chalk.red('─')
      } else {
        result[rows - y1][x + offset + this.buys.length - 1] = chalk.red((y0 > y1) ? '╰' : '╭')
        result[rows - y0][x + offset + this.buys.length - 1] = chalk.red((y0 > y1) ? '╮' : '╯')
        let from = Math.min(y0, y1)
        let to = Math.max(y0, y1)
        for (let y = from + 1; y < to; y++) {
          result[rows - y][x + offset + this.buys.length - 1] = chalk.red('│')
        }
      }
    }

    // if the order book chart was truncated, give an indication of that fact
    if (this.truncated) { result[0][width] = chalk.red('↑') }

    return result.map (function (x) { return x.join ('') }).join ('\n')
  }

  private buyDepthAtIndex(idx: number) {
    let result = this.buyDepth
    for (let i = 0; i <= idx; ++i) {
      result = result.minus(this.etherBalance(this.buys[i]))
    }
    return result
  }

  private sellDepthAtIndex(idx: number) {
    let result = new BigNumber(0)
    for (let i = 0; i <= idx; ++i) {
      result = result.plus(this.etherBalance(this.sells[i]))
    }
    return result
  }

  private filterSellOrders(orders: any) {
    let upperLimit = this.buyDepth.times(new BigNumber(1.5))
    let currentLimit = new BigNumber(0)
    let result = []
    // need minimum 2 orders
    result.push(orders[0])
    result.push(orders[1])
    for (let i = 2; i < orders.length; ++i) {
      currentLimit = currentLimit.plus(this.etherBalance(orders[i]))
      if (currentLimit.lte(upperLimit)) {
        result.push(orders[i])
      } else {
        // zoom in on the orderbook chart
        orders[i].balance = upperLimit.dividedBy(new BigNumber(orders[i].price)).toFixed()
        result.push(orders[i])
        this.truncated = true
        break
      }
    }
    return result
  }

  private etherBalance(order: any) {
    return new BigNumber(order.balance).times(new BigNumber(order.price))
  }
}
